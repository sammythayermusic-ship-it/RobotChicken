/**
 * In-memory Ledger and Chain for the synthetic-month tests. They mirror what
 * apps/worker does on Supabase and Solana closely enough that the Treasury
 * engine runs unchanged: booked payouts, trailing windows, per-wallet caps,
 * idempotency keys, signed-then-sent transfers, balances that can run dry.
 */
import {
  DAY_MS, HOUR_MS, bps, dayStart, matchWeightMilli, utcDay, winAmount,
  type Alerts, type Chain, type ClaimRecord, type ClaimResult, type DailyPoolBooking, type DailyReward, type EconomyParams, type Ledger,
  type LedgerWindow, type PauseState, type PayoutRow, type PoolState, type PreparedTransfer, type Price, type RankedPlayer,
  type SeedBalance, type SeedDraw, type TxStatus, type WinBooking,
} from "../src";

export interface SimMatch extends WinBooking {
  weightMilli: bigint;
  /** What the win booked (0 when capped, flagged or q = 0). */
  booked: bigint;
}

export interface SimPayout extends PayoutRow {
  matchId: string | null;
  day: string | null;
  rank: number | null;
  paidAt: number | null;
  lastError: string | null;
  nextAttemptAt: number | null;
  /** Price at send time, for the USD cap checks in the tests. */
  sentPriceUsd: number | null;
}

let nextId = 1;
const id = () => `row-${nextId++}`;

export class MemoryLedger implements Ledger {
  readonly params: EconomyParams;
  readonly claims: ClaimRecord[] = [];
  readonly matches: SimMatch[] = [];
  readonly payouts: SimPayout[] = [];
  readonly byKey = new Map<string, SimPayout>();
  readonly dailies = new Map<string, { pool: bigint; rewards: DailyReward[] }>();
  readonly seedDraws = new Map<string, { draw: SeedDraw; sig: string | null }>();
  readonly flagged = new Set<string>();
  seedBalance: SeedBalance = { original: 0n, remaining: 0n };
  pauseState: PauseState = { paused: false, reason: null };
  state: PoolState | null = null;
  stateAt = 0;
  /** Every pool state written, for the tests. */
  readonly states: { at: number; state: PoolState }[] = [];
  priceNow: () => Price;

  constructor(params: EconomyParams, priceNow: () => Price) {
    this.params = params;
    this.priceNow = priceNow;
  }

  /** Matches and sent payouts bucketed by hour, so a month of windows stays linear. */
  readonly #matchesByHour = new Map<number, SimMatch[]>();
  readonly #sentByHour = new Map<number, SimPayout[]>();
  readonly #open = new Set<SimPayout>();
  readonly #paidWinsByDay = new Map<number, Map<string, number>>();
  readonly #pairsByDay = new Map<number, Map<string, number>>();

  static #sumHours<T>(map: Map<number, T[]>, from: number, to: number, at: (x: T) => number | null, amount: (x: T) => bigint): bigint {
    let out = 0n;
    for (let h = Math.floor(from / HOUR_MS); h <= Math.floor(to / HOUR_MS); h++) {
      for (const x of map.get(h) ?? []) {
        const t = at(x);
        if (t !== null && t > from && t <= to) out += amount(x);
      }
    }
    return out;
  }

  async window(now: number): Promise<LedgerWindow> {
    const h24 = now - DAY_MS;
    const h1 = now - HOUR_MS;
    const today = dayStart(now);
    let gross24h = 0n, grossToday = 0n, playerShare24h = 0n;
    for (const c of this.claims) {
      if (c.at > h24 && c.at <= now) {
        gross24h += c.gross;
        playerShare24h += c.playerShare;
      }
      if (c.at >= today && c.at <= now) grossToday += c.gross;
    }
    const weighted24hMilli = MemoryLedger.#sumHours(this.#matchesByHour, h24, now, (m) => m.endedAt, (m) => m.weightMilli);
    const sentAt = (p: SimPayout) => (p.status === "sent" || p.status === "paid" ? p.sentAt : null);
    const sentLastHour = MemoryLedger.#sumHours(this.#sentByHour, h1, now, sentAt, (p) => (p.kind === "win" ? p.amount : 0n));
    const sentToday = MemoryLedger.#sumHours(this.#sentByHour, today - 1, now, sentAt, (p) => p.amount);
    let outstanding = 0n;
    for (const p of this.#open) outstanding += p.amount;
    const seedToday = this.seedDraws.get(utcDay(now))?.draw ?? { win: 0n, daily: 0n, total: 0n, shortfall: 0n };
    return { gross24h, grossToday, playerShare24h, weighted24hMilli, allowance: this.allowance, sentLastHour, sentToday, outstanding, seedToday };
  }

  async writePoolState(state: PoolState, now: number): Promise<void> {
    this.state = state;
    this.stateAt = now;
    this.states.push({ at: now, state });
  }

  /** The ledger's own count of what the hot wallet should hold (see BudgetView). */
  allowance = 0n;
  readonly sweeps: { amount: bigint; sig: string; at: number }[] = [];

  async recordClaim(c: ClaimRecord): Promise<void> {
    if (this.claims.some((x) => x.sig === c.sig)) throw new Error("duplicate claim signature");
    this.claims.push(c);
    this.allowance += c.playerShare;
  }

  async recordSweep(amount: bigint, sig: string, at: number): Promise<void> {
    this.sweeps.push({ amount, sig, at });
    this.allowance -= amount;
    if (this.allowance < 0n) throw new Error("sweep took the allowance negative");
  }

  async duePayouts(now: number, limit: number): Promise<PayoutRow[]> {
    return [...this.#open]
      .filter((p) => p.status === "pending" || (p.status === "deferred" && (p.nextAttemptAt ?? 0) <= now))
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, limit);
  }

  readonly #sent = new Set<SimPayout>();

  async sentPayouts(): Promise<PayoutRow[]> {
    return [...this.#sent];
  }

  readonly #byId = new Map<string, SimPayout>();

  #row(rowId: string): SimPayout {
    const r = this.#byId.get(rowId);
    if (!r) throw new Error(`no payout ${rowId}`);
    return r;
  }

  async markSent(rowId: string, sig: string, at: number): Promise<void> {
    const r = this.#row(rowId);
    if (r.status === "sent" || r.status === "paid") throw new Error(`payout ${rowId} sent twice`);
    if (this.payouts.some((p) => p.sig === sig)) throw new Error("duplicate signature");
    r.status = "sent";
    r.sig = sig;
    r.sentAt = at;
    r.sentPriceUsd = this.priceNow().usd;
    this.allowance -= r.amount;
    if (this.allowance < 0n) throw new Error(`allowance negative after ${r.idemKey}`);
    this.#open.delete(r);
    this.#sent.add(r);
    const h = Math.floor(at / HOUR_MS);
    let b = this.#sentByHour.get(h);
    if (!b) this.#sentByHour.set(h, (b = []));
    b.push(r);
  }

  async markPaid(rowId: string, at: number): Promise<void> {
    const r = this.#row(rowId);
    r.status = "paid";
    r.paidAt = at;
    this.#sent.delete(r);
  }

  async markDeferred(rowId: string, reason: string, nextAt: number): Promise<void> {
    const r = this.#row(rowId);
    r.status = "deferred";
    r.lastError = reason;
    r.nextAttemptAt = nextAt;
  }

  async markRetry(rowId: string, reason: string): Promise<void> {
    const r = this.#row(rowId);
    const h = Math.floor((r.sentAt ?? 0) / HOUR_MS);
    this.#sentByHour.set(h, (this.#sentByHour.get(h) ?? []).filter((x) => x !== r));
    r.status = "pending";
    r.sig = null;
    r.sentAt = null;
    r.attempts += 1;
    r.lastError = reason;
    this.allowance += r.amount;
    this.#sent.delete(r);
    this.#open.add(r);
  }

  async markFailed(rowId: string, reason: string): Promise<void> {
    const r = this.#row(rowId);
    r.status = "failed";
    r.lastError = reason;
    this.#sent.delete(r);
    this.#open.delete(r);
  }

  async pause(): Promise<PauseState> {
    return this.pauseState;
  }

  async setPause(paused: boolean, reason: string | null): Promise<void> {
    this.pauseState = { paused, reason };
  }

  async hasDaily(day: string): Promise<boolean> {
    return this.dailies.has(day);
  }

  async dailyRanking(day: string): Promise<RankedPlayer[]> {
    const start = Date.parse(`${day}T00:00:00Z`);
    const wins = new Map<string, number>();
    for (const m of this.matches) {
      if (m.endedAt < start || m.endedAt >= start + DAY_MS || this.flagged.has(m.winner)) continue;
      wins.set(m.winner, (wins.get(m.winner) ?? 0) + 1);
    }
    return [...wins].map(([address, w]) => ({ address, wins: w })).sort((a, b) => b.wins - a.wins || a.address.localeCompare(b.address));
  }

  async dailyPoolInputs(day: string): Promise<{ grossDay: bigint; seedDaily: bigint }> {
    const start = Date.parse(`${day}T00:00:00Z`);
    let grossDay = 0n;
    for (const c of this.claims) if (c.at >= start && c.at < start + DAY_MS) grossDay += c.gross;
    return { grossDay, seedDaily: this.seedDraws.get(day)?.draw.daily ?? 0n };
  }

  async bookDaily(day: string, booking: DailyPoolBooking, rewards: DailyReward[]): Promise<void> {
    if (this.dailies.has(day)) return;
    const pool = booking.pool;
    const seen = new Set<string>();
    for (const r of rewards) {
      if (seen.has(r.address)) throw new Error("one address under two ranks");
      seen.add(r.address);
      this.#insert({ kind: "daily", idemKey: `daily:${day}:${r.rank}`, to: r.address, amount: r.amount, matchId: null, day, rank: r.rank, createdAt: Date.parse(`${day}T00:00:00Z`) + DAY_MS });
    }
    this.dailies.set(day, { pool, rewards });
  }

  async seed(): Promise<SeedBalance> {
    return this.seedBalance;
  }

  async hasSeedDraw(day: string): Promise<boolean> {
    return this.seedDraws.has(day);
  }

  async bookSeedDraw(day: string, draw: SeedDraw, sig: string | null): Promise<void> {
    if (this.seedDraws.has(day)) return;
    this.seedDraws.set(day, { draw, sig });
    this.seedBalance = { ...this.seedBalance, remaining: this.seedBalance.remaining - draw.total };
    this.allowance += draw.total;
    if (this.seedBalance.remaining < 0n) throw new Error("seed overdrawn");
  }

  /** The same rules record_match applies in SQL: q, the per-wallet caps, flagged wallets. */
  async bookWin(w: WinBooking): Promise<bigint> {
    const day = dayStart(w.endedAt);
    let wins = this.#paidWinsByDay.get(day);
    if (!wins) this.#paidWinsByDay.set(day, (wins = new Map()));
    let pairs = this.#pairsByDay.get(day);
    if (!pairs) this.#pairsByDay.set(day, (pairs = new Map()));
    const pairKey = [w.winner, w.loser].sort().join("|");
    const paidWins = wins.get(w.winner) ?? 0;
    const vsSame = pairs.get(pairKey) ?? 0;
    let amount = 0n;
    if (this.state && w.qualityBps > 0 && !this.flagged.has(w.winner) && paidWins < this.params.maxPaidWinsPerDay && vsSame < this.params.maxPaidVsSameOpponentPerDay) {
      amount = winAmount(this.state, w.tier, w.qualityBps);
    }
    const m: SimMatch = { ...w, weightMilli: matchWeightMilli(w.tier, this.params), booked: amount };
    this.matches.push(m);
    const h = Math.floor(w.endedAt / HOUR_MS);
    let b = this.#matchesByHour.get(h);
    if (!b) this.#matchesByHour.set(h, (b = []));
    b.push(m);
    if (amount > 0n) {
      wins.set(w.winner, paidWins + 1);
      pairs.set(pairKey, vsSame + 1);
      this.#insert({ kind: "win", idemKey: `win:${w.matchId}`, to: w.winner, amount, matchId: w.matchId, day: null, rank: null, createdAt: w.endedAt });
    }
    return amount;
  }

  #insert(p: { kind: "win" | "daily"; idemKey: string; to: string; amount: bigint; matchId: string | null; day: string | null; rank: number | null; createdAt: number }): void {
    if (this.byKey.has(p.idemKey)) return; // idempotent on the key, like the unique index
    const row: SimPayout = { id: id(), status: "pending", sig: null, attempts: 0, sentAt: null, paidAt: null, lastError: null, nextAttemptAt: null, sentPriceUsd: null, ...p };
    this.payouts.push(row);
    this.byKey.set(p.idemKey, row);
    this.#byId.set(row.id, row);
    this.#open.add(row);
  }

  /** Total booked per address on a UTC day (paid wins), for the cap tests. */
  paidWinsOn(day: string): Map<string, number> {
    const start = Date.parse(`${day}T00:00:00Z`);
    const out = new Map<string, number>();
    for (const m of this.matches) if (m.booked > 0n && m.endedAt >= start && m.endedAt < start + DAY_MS) out.set(m.winner, (out.get(m.winner) ?? 0) + 1);
    return out;
  }
}

export interface ChainOptions {
  price: () => Price;
  playerShareBps: number;
  hotSol?: bigint;
  /** Whether a cold wallet exists (sweeps go there). */
  cold?: boolean;
}

export class MemoryChain implements Chain {
  readonly o: Required<ChainOptions>;
  /** Fees accrued in the creator vault, not yet distributed (gross). */
  vault = 0n;
  hot = 0n;
  seedWallet = 0n;
  cold = 0n;
  project = 0n;
  /** Recipient balances (players). */
  readonly balances = new Map<string, bigint>();
  /** Every transfer that landed, by signature. */
  readonly landed = new Map<string, { to: string; amount: bigint; memo: string }>();
  /** Signed transfers that were never submitted (a crash between sign and send): they expire. */
  readonly unsent = new Set<string>();
  /** Fault injection. */
  claimFails = false;
  dropSubmits = false;
  sweeps: bigint[] = [];
  claims: bigint[] = [];
  #sig = 1;

  constructor(o: ChainOptions) {
    this.o = { hotSol: 1_000_000_000n, cold: true, ...o };
  }

  accrue(gross: bigint): void {
    this.vault += gross;
  }

  async price(): Promise<Price> {
    return this.o.price();
  }

  async hotBalance(): Promise<bigint> {
    return this.hot;
  }

  async hotSol(): Promise<bigint> {
    return this.o.hotSol;
  }

  async prepareTransfer(to: string, amount: bigint, memo: string): Promise<PreparedTransfer> {
    const sig = `sig-${this.#sig++}`;
    this.unsent.add(sig);
    return {
      sig,
      submit: async () => {
        if (this.dropSubmits) throw new Error("rpc unreachable");
        if (amount > this.hot) throw new Error(`insufficient funds: ${amount} > ${this.hot}`);
        this.unsent.delete(sig);
        this.hot -= amount;
        this.balances.set(to, (this.balances.get(to) ?? 0n) + amount);
        this.landed.set(sig, { to, amount, memo });
      },
    };
  }

  async status(sig: string, _sentAt: number): Promise<TxStatus> {
    if (this.landed.has(sig)) return "confirmed";
    if (this.unsent.has(sig)) return "expired";
    return "unknown";
  }

  async claim(): Promise<ClaimResult | null> {
    if (this.claimFails) throw new Error("rpc error: distribute failed");
    if (this.vault === 0n) return null;
    const gross = this.vault;
    this.vault = 0n;
    const received = bps(gross, this.o.playerShareBps);
    this.hot += received;
    this.project += gross - received;
    this.claims.push(gross);
    return { stage: "curve", received, sig: `claim-${this.#sig++}` };
  }

  async seedTransfer(amount: bigint): Promise<string> {
    if (amount > this.seedWallet) throw new Error("seed wallet short");
    this.seedWallet -= amount;
    this.hot += amount;
    return `seed-${this.#sig++}`;
  }

  async sweep(amount: bigint): Promise<string | null> {
    if (!this.o.cold) return null;
    if (amount > this.hot) throw new Error("sweep over balance");
    this.hot -= amount;
    this.cold += amount;
    this.sweeps.push(amount);
    return `sweep-${this.#sig++}`;
  }
}

export class MemoryAlerts implements Alerts {
  readonly sent: { kind: string; message: string }[] = [];
  async alert(kind: "pause" | "low_sol" | "claim_failed" | "info", message: string): Promise<void> {
    this.sent.push({ kind, message });
  }
}

/** Small deterministic PRNG (mulberry32) so a failing month is reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
