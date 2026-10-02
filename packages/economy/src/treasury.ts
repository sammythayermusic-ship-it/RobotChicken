/**
 * The treasury: every job the worker runs, written against the Ledger and
 * Chain interfaces so the simulator can drive a synthetic month through the
 * same code.
 *
 *   every minute  recompute()   pool state from the ledger → pool_state row
 *   every 5 s     payPass()     send due payouts (allowance, caps, wallet cover), confirm sent ones
 *   every minute  claimTick()   price, distribute creator fees to the hot wallet (the pot keeps all of it)
 *   every minute  syncPot()     PUMP in the hot wallet the books don't know about → the pot (inside claimTick)
 *   00:00 UTC     midnight()    pay yesterday's top 10, book today's seed draw
 *   at boot       reconcile()   settle rows left `sent` by a crash, run a missed midnight
 */
import { minRaw, rawToUsd, usdToRaw, type Price } from "./money";
import { validateParams, type EconomyParams } from "./params";
import {
  computePoolState, dailyRewards, decideSend, seedDraw, type PoolState, type SeedDraw,
} from "./pool";
import type { Alerts, Chain, Ledger } from "./ledger";

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
/** A single dropped claim is routine on a busy network; alert when this many in a row fail. */
export const CLAIM_ALERT_AFTER = 3;
/** While claims keep failing, repeat the alert every this many more (36 × 10 min = 6 h). */
export const CLAIM_REMIND_EVERY = 36;

/** UTC day of a timestamp as YYYY-MM-DD. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function dayStart(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

/** The UTC day before `day`. */
export function previousDay(day: string): string {
  return utcDay(Date.parse(`${day}T00:00:00Z`) - DAY_MS);
}

export interface TreasuryOptions {
  params: EconomyParams;
  ledger: Ledger;
  chain: Chain;
  alerts: Alerts;
  now?: () => number;
  /** How many payouts one pass sends at most. */
  batch?: number;
  /** Deferred rows are retried after this long. */
  deferMs?: number;
  /** A transfer that is neither confirmed nor failed this long after sending is treated as expired. */
  expireMs?: number;
  /** Give up on a payout after this many expired attempts. */
  maxAttempts?: number;
  /** Don't sweep less than this to the cold wallet (USD). */
  minSweepUsd?: number;
  /** Alert when the hot wallet's SOL for fees drops under this (lamports). */
  lowSolLamports?: bigint;
  /** False in observer mode (no seed key): midnight books the daily rewards but no seed draw. */
  drawSeed?: boolean;
  /**
   * Book PUMP that lands in the hot wallet outside the ledger (Sammy's deposits,
   * fees someone else distributed) into the pot, every claim tick. The worker
   * turns it on; the month test leaves it off so its dust stays out of the books.
   */
  autoTopUp?: boolean;
  /** Ignore a gap between the wallet and the books smaller than this (USD). */
  minTopUpUsd?: number;
}

export interface PayPassResult {
  sent: number;
  deferred: number;
  confirmed: number;
  retried: number;
  failed: number;
}

export class Treasury {
  readonly params: EconomyParams;
  readonly ledger: Ledger;
  readonly chain: Chain;
  readonly alerts: Alerts;
  readonly now: () => number;
  readonly batch: number;
  readonly deferMs: number;
  readonly expireMs: number;
  readonly maxAttempts: number;
  readonly minSweepUsd: number;
  readonly lowSolLamports: bigint;
  readonly drawSeed: boolean;
  readonly autoTopUp: boolean;
  readonly minTopUpUsd: number;
  /** The price fetched at the last claim tick (or boot); pool maths use it until the next one. */
  price: Price | null = null;
  /** The last computed pool state (what the site and the game server see). */
  state: PoolState | null = null;
  /** In-flight sends by row id: a pass never double-sends a row it is already sending. */
  readonly #inflight = new Set<string>();
  #lowSolAlerted = false;
  /** Claim ticks that failed in a row (price or claim); reset by the next good one. */
  claimFailStreak = 0;
  /** payPass and syncPot never overlap: syncPot compares the wallet with the books, and a send in flight would skew that. */
  #lock: Promise<unknown> = Promise.resolve();
  #shortAlerted = false;

  constructor(o: TreasuryOptions) {
    validateParams(o.params);
    this.params = o.params;
    this.ledger = o.ledger;
    this.chain = o.chain;
    this.alerts = o.alerts;
    this.now = o.now ?? Date.now;
    this.batch = o.batch ?? 25;
    this.deferMs = o.deferMs ?? 60_000;
    this.expireMs = o.expireMs ?? 120_000;
    this.maxAttempts = o.maxAttempts ?? 5;
    this.minSweepUsd = o.minSweepUsd ?? 50;
    this.lowSolLamports = o.lowSolLamports ?? 50_000_000n;
    this.drawSeed = o.drawSeed ?? true;
    this.autoTopUp = o.autoTopUp ?? false;
    this.minTopUpUsd = o.minTopUpUsd ?? 0.25;
  }

  /** Run `fn` with no payPass / syncPot running alongside it. */
  #exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#lock.then(fn, fn);
    this.#lock = run.catch(() => undefined);
    return run;
  }

  /** Replace the knobs at runtime (/admin settings); an invalid set is rejected and the old one kept. */
  updateParams(p: EconomyParams): void {
    validateParams(p);
    (this as { params: EconomyParams }).params = p;
  }

  /** Fetch the price (kept until the next claim tick). Throws when no source answers. */
  async refreshPrice(): Promise<Price> {
    this.price = await this.chain.price();
    return this.price;
  }

  /** Pool state from the ledger, written for the game server and the site. */
  async recompute(now = this.now()): Promise<PoolState> {
    const price = this.price ?? (await this.refreshPrice());
    const w = await this.ledger.window(now);
    const state = computePoolState(
      {
        gross24h: w.gross24h,
        grossToday: w.grossToday,
        seedWinTopUp: w.seedToday.win,
        seedDailyTopUp: w.seedToday.daily,
        weighted24hMilli: w.weighted24hMilli,
        allowance: w.allowance,
        outstanding: w.outstanding,
        // The peak survives restarts in pool_state; this process may know a newer one.
        peakUsd: Math.max(w.potPeakUsd, this.state?.peakUsd ?? 0),
        price,
      },
      this.params,
    );
    this.state = state;
    await this.ledger.writePoolState(state, now);
    return state;
  }

  /** Every claim window (10 min): price, creator fees → hot wallet, sweep what the hot wallet doesn't need. */
  async claimTick(now = this.now()): Promise<void> {
    let price: Price;
    try {
      price = await this.refreshPrice();
    } catch (e) {
      await this.#claimFailed(`price unavailable: ${msg(e)}`);
      return;
    }
    try {
      const res = await this.chain.claim();
      if (res && res.received > 0n) {
        const gross = (res.received * 10_000n) / BigInt(this.params.playerShareBps);
        await this.ledger.recordClaim({
          at: now,
          stage: res.stage,
          gross,
          playerShare: res.received,
          projectShare: gross - res.received,
          sig: res.sig,
          priceUsd: price.usd,
        });
      }
      if (this.claimFailStreak >= CLAIM_ALERT_AFTER) {
        await this.alerts.alert("info", `fee claims are working again after ${this.claimFailStreak} failed in a row`);
      }
      this.claimFailStreak = 0;
    } catch (e) {
      // Invariant 7: payouts go on from what is already booked; the site keeps its real numbers.
      // The fees stay in the vault, so the next tick collects them.
      await this.#claimFailed(`fee claim failed: ${msg(e)}`);
    }
    if (this.autoTopUp) {
      try {
        await this.syncPot(now);
      } catch (e) {
        console.warn(`[treasury] pot sync failed: ${msg(e)}`);
      }
    }
    await this.recompute(now);
    await this.#sweep(now);
    await this.#checkSol();
  }

  /** Count a failed claim tick; alert on the CLAIM_ALERT_AFTER-th in a row, then every CLAIM_REMIND_EVERY more. */
  async #claimFailed(why: string): Promise<void> {
    const n = ++this.claimFailStreak;
    console.warn(`[treasury] claim tick failed (${n} in a row): ${why}`);
    if (n === CLAIM_ALERT_AFTER || (n > CLAIM_ALERT_AFTER && (n - CLAIM_ALERT_AFTER) % CLAIM_REMIND_EVERY === 0)) {
      await this.alerts.alert("claim_failed", `${n} fee claims in a row failed (fees wait in the vault meanwhile). Last: ${why}`);
    }
  }

  /** Invariant 3: the hot wallet keeps its target plus what is already booked; the rest goes to cold. */
  async #sweep(now: number): Promise<void> {
    if (!this.state) return;
    const w = await this.ledger.window(now);
    const keep = this.state.hotTarget + w.outstanding;
    const balance = await this.chain.hotBalance();
    // The lesser of what the ledger says is spare and what the wallet really
    // holds: dust that never went through the ledger stays where it is.
    const excess = minRaw(balance - keep, w.allowance - keep);
    if (excess <= 0n || excess < usdToRaw(this.minSweepUsd, this.state.price)) return;
    try {
      const sig = await this.chain.sweep(excess);
      if (sig) await this.ledger.recordSweep(excess, sig, now);
    } catch (e) {
      await this.alerts.alert("info", `sweep to cold failed: ${msg(e)}`);
    }
  }

  async #checkSol(): Promise<void> {
    try {
      const sol = await this.chain.hotSol();
      if (sol < this.lowSolLamports) {
        if (!this.#lowSolAlerted) await this.alerts.alert("low_sol", `hot wallet SOL for fees is low: ${Number(sol) / 1e9} SOL`);
        this.#lowSolAlerted = true;
      } else {
        this.#lowSolAlerted = false;
      }
    } catch {
      /* the next tick tries again */
    }
  }

  /**
   * Send what is due. Invariants 1, 4, 5, 6: budget, caps, idempotency,
   * wallet cover. The signature is written to the ledger before the
   * transaction is broadcast, so a crash in between is settled by
   * reconcile() and a row is never paid twice.
   */
  payPass(now = this.now()): Promise<PayPassResult> {
    return this.#exclusive(() => this.#payPass(now));
  }

  /**
   * The wallet and the books, compared: PUMP in the hot wallet that the ledger
   * doesn't count (a deposit, fees someone else distributed, dust) is booked as
   * a pot top-up, so it is in the next win. Never books more than the wallet
   * holds, so the pot can't promise what isn't there; skips while a payout is
   * sent but unconfirmed (the wallet hasn't dropped yet). A wallet holding less
   * than the books (PUMP moved out by hand) is alerted once, not booked.
   * Returns what it booked (0n when nothing).
   */
  syncPot(now = this.now()): Promise<bigint> {
    return this.#exclusive(async () => {
      if ((await this.ledger.sentPayouts()).length > 0) return 0n;
      const price = this.price ?? (await this.refreshPrice());
      const w = await this.ledger.window(now);
      const balance = await this.chain.hotBalance();
      const gap = balance - w.allowance;
      const min = usdToRaw(this.minTopUpUsd, price);
      const tokens = (raw: bigint) => (Number(raw) / Number(10n ** BigInt(price.decimals))).toLocaleString("en-US", { maximumFractionDigits: 2 });
      if (gap > 0n && gap >= min) {
        await this.ledger.recordTopup(gap, "auto: found in the hot wallet", now);
        this.#shortAlerted = false;
        await this.alerts.alert("info", `added ${tokens(gap)} PUMP (~$${rawToUsd(gap, price).toFixed(2)}) to the prize pot: it landed in the hot wallet`);
        return gap;
      }
      if (gap < 0n && -gap >= min) {
        if (!this.#shortAlerted) {
          await this.alerts.alert("info", `the hot wallet holds ${tokens(-gap)} PUMP less than the books (moved out by hand?). Wins still pay from what is there; send PUMP back to cover it.`);
        }
        this.#shortAlerted = true;
      } else {
        this.#shortAlerted = false;
      }
      return 0n;
    });
  }

  async #payPass(now: number): Promise<PayPassResult> {
    const r: PayPassResult = { sent: 0, deferred: 0, confirmed: 0, retried: 0, failed: 0 };
    await this.#confirmSent(now, r);
    const pause = await this.ledger.pause();
    const rows = await this.ledger.duePayouts(now, this.batch);
    if (rows.length === 0) return r;
    const price = this.price ?? (await this.refreshPrice());
    const w = await this.ledger.window(now);
    let balance = await this.chain.hotBalance();
    let allowance = w.allowance;
    let sentLastHour = w.sentLastHour;
    let sentToday = w.sentToday;
    let paused = pause.paused;
    for (const row of rows) {
      if (this.#inflight.has(row.id)) continue;
      const d = decideSend(row.amount, row.kind, { allowance, sentLastHour, sentToday, price, walletBalance: balance, paused }, this.params);
      if (!d.ok) {
        r.deferred++;
        await this.ledger.markDeferred(row.id, d.defer, now + this.deferMs);
        if (d.pause && !paused) {
          paused = true;
          await this.ledger.setPause(true, `cap hit: ${d.defer} on ${row.idemKey}`);
          await this.alerts.alert("pause", `payouts paused: ${d.defer} cap hit on ${row.idemKey} (${row.amount} raw). Clear it in /admin.`);
        }
        continue;
      }
      this.#inflight.add(row.id);
      try {
        const tx = await this.chain.prepareTransfer(row.to, row.amount, row.idemKey);
        await this.ledger.markSent(row.id, tx.sig, now);
        allowance -= row.amount;
        if (row.kind === "win") sentLastHour += row.amount;
        sentToday += row.amount;
        balance -= row.amount;
        r.sent++;
        try {
          await tx.submit();
        } catch {
          // Broadcast failed: the row stays `sent` with its signature; reconcile()/#confirmSent
          // settle it (a signed tx that never reached the network expires with its blockhash).
        }
      } catch (e) {
        r.deferred++;
        await this.ledger.markDeferred(row.id, `send error: ${msg(e)}`, now + this.deferMs);
      } finally {
        this.#inflight.delete(row.id);
      }
    }
    return r;
  }

  /** Rows `sent`: paid when confirmed; back to pending when expired; failed after too many tries. */
  async #confirmSent(now: number, r: PayPassResult): Promise<void> {
    for (const row of await this.ledger.sentPayouts()) {
      if (!row.sig) continue;
      const sentAt = row.sentAt ?? row.createdAt;
      const st = await this.chain.status(row.sig, sentAt);
      if (st === "confirmed") {
        await this.ledger.markPaid(row.id, now);
        r.confirmed++;
      } else if (st === "failed" || (st === "expired" && row.attempts + 1 >= this.maxAttempts) || (st === "unknown" && now - sentAt > this.expireMs * this.maxAttempts * 4)) {
        await this.ledger.markFailed(row.id, `transaction ${st}: ${row.sig}`);
        r.failed++;
        await this.alerts.alert("info", `payout ${row.idemKey} failed (${st}); it needs a look in /admin`);
      } else if (st === "expired") {
        await this.ledger.markRetry(row.id, `transaction expired: ${row.sig}`);
        r.retried++;
      }
    }
  }

  /**
   * At 00:00 UTC (or the first run after it): pay the closed day's top 10
   * from its pool, then book the new day's seed draw. Both are idempotent on
   * the day, so a crash halfway is finished by the next call.
   */
  async midnight(now = this.now()): Promise<{ daily: number; seed: SeedDraw | null }> {
    const today = utcDay(now);
    const yesterday = previousDay(today);
    let daily = 0;
    if (!(await this.ledger.hasDaily(yesterday))) {
      const { grossDay, seedDaily } = await this.ledger.dailyPoolInputs(yesterday);
      const pool = (grossDay * BigInt(this.params.dailyPoolBps)) / 10_000n + seedDaily;
      const ranking = await this.ledger.dailyRanking(yesterday);
      const rewards = dailyRewards(pool, ranking, this.params);
      await this.ledger.bookDaily(yesterday, { grossDay, seedDaily, pool }, rewards);
      daily = rewards.length;
    }
    let seed: SeedDraw | null = null;
    if (this.drawSeed && !(await this.ledger.hasSeedDraw(today))) {
      const price = this.price ?? (await this.refreshPrice());
      const w = await this.ledger.window(now);
      const { grossDay } = await this.ledger.dailyPoolInputs(yesterday);
      const bal = await this.ledger.seed();
      seed = seedDraw({ gross24h: w.gross24h, grossDay, seedOriginal: bal.original, seedRemaining: bal.remaining, price }, this.params);
      seed.total = minRaw(seed.total, bal.remaining);
      let sig: string | null = null;
      if (seed.total > 0n) {
        try {
          sig = await this.chain.seedTransfer(seed.total);
        } catch (e) {
          // Not booked: the next call (every minute) tries again, so a
          // transient RPC error at midnight doesn't cost the day its seed.
          await this.alerts.alert("info", `seed draw failed, will retry: ${msg(e)}`);
          return { daily, seed: null };
        }
      }
      await this.ledger.bookSeedDraw(today, seed, sig);
      await this.recompute(now);
    }
    return { daily, seed };
  }

  /** At boot: settle what a crash left behind, then run whatever midnight is missing. */
  async reconcile(now = this.now()): Promise<void> {
    await this.refreshPrice();
    const r: PayPassResult = { sent: 0, deferred: 0, confirmed: 0, retried: 0, failed: 0 };
    await this.#confirmSent(now, r);
    await this.midnight(now);
    await this.recompute(now);
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
