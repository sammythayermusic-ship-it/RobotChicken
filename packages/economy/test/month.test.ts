/**
 * A synthetic month through the real Treasury engine: a launch spike, a
 * decline, dead days, a gold whale grinding, a bot burst, a fee-claim outage,
 * a price swing, a crash between sign and send. Every invariant from
 * docs/plan-phase3.md is asserted on the ledger the run leaves behind.
 */
import { describe, expect, it } from "vitest";
import {
  DAY_MS, DEFAULT_PARAMS, HOUR_MS, Treasury, rawToUsd, usdToRaw, utcDay,
  type EconomyParams, type PayTier, type Price,
} from "../src";
import { MemoryAlerts, MemoryChain, MemoryLedger, rng, type SimPayout } from "./simulator";

const T0 = Date.parse("2026-10-01T00:00:00Z");
const DAYS = 30;
const DECIMALS = 6;

interface Run {
  params: EconomyParams;
  ledger: MemoryLedger;
  chain: MemoryChain;
  alerts: MemoryAlerts;
  treasury: Treasury;
  /** Per hour: the hot balance after the sweep and after the pay pass, what the sweep had to keep, the ledger allowance. */
  hours: { at: number; hot: bigint; hotAfterSweep: bigint; keep: bigint; allowance: bigint; pausedAt: boolean }[];
  dust: bigint;
  whale: string;
  bots: string[];
  outageHours: number[];
  crashRows: string[];
}

/** Daily trading volume in USD: launch spike, decay, weekend bumps, three dead days. */
function dayVolume(day: number, r: () => number): number {
  if (day === 12 || day === 13 || day === 25) return 0;
  const base = day < 3 ? 800_000 : day < 10 ? 250_000 : 60_000;
  const weekend = day % 7 === 5 || day % 7 === 6 ? 1.4 : 1;
  return base * weekend * (0.7 + 0.6 * r());
}

function hourShare(h: number): number {
  // A day's volume peaks in the US evening; never quite zero.
  return (1 + Math.sin(((h - 14) / 24) * 2 * Math.PI)) / 24 + 0.01;
}

async function runMonth(opts: { seedUsd: number; gWinUsd: number; gDailyUsd: number; seed?: number }): Promise<Run> {
  const r = rng(opts.seed ?? 7);
  let priceUsd = 0.005;
  const price = (): Price => ({ usd: priceUsd, decimals: DECIMALS });
  const params: EconomyParams = { ...DEFAULT_PARAMS, gWinUsd: opts.gWinUsd, gDailyUsd: opts.gDailyUsd };
  const ledger = new MemoryLedger(params, price);
  const chain = new MemoryChain({ price, playerShareBps: params.playerShareBps });
  const alerts = new MemoryAlerts();
  const seedRaw = usdToRaw(opts.seedUsd, price());
  chain.seedWallet = seedRaw;
  ledger.seedBalance = { original: seedRaw, remaining: seedRaw };
  const dust = usdToRaw(20, price()); // a little left over from testing, not in the ledger
  chain.hot = dust;
  const mk = (t: Treasury | null) => new Treasury({ params, ledger, chain, alerts, batch: 100_000, deferMs: HOUR_MS, expireMs: HOUR_MS, minSweepUsd: 50, now: () => (t ? t.now() : T0) });
  let treasury = mk(null);
  await treasury.reconcile(T0);

  const players: Record<PayTier, string[]> = {
    rust: Array.from({ length: 300 }, (_, i) => `rust-${i}`),
    chrome: Array.from({ length: 80 }, (_, i) => `chrome-${i}`),
    gold: Array.from({ length: 25 }, (_, i) => `gold-${i}`),
  };
  const whale = "gold-whale";
  const bots = Array.from({ length: 50 }, (_, i) => `bot-${i}`);
  bots.slice(0, 5).forEach((b) => ledger.flagged.add(b));
  const pick = (arr: string[]) => arr[Math.floor(r() * arr.length)] as string;
  const tierOf = (): PayTier => {
    const x = r();
    return x < 0.65 ? "rust" : x < 0.92 ? "chrome" : "gold";
  };
  const hours: Run["hours"] = [];
  const outageHours: number[] = [];
  const crashRows: string[] = [];
  let matchN = 0;

  for (let h = 0; h < DAYS * 24; h++) {
    const now = T0 + h * HOUR_MS;
    const day = Math.floor(h / 24);
    const hod = h % 24;
    if (hod === 0 && h > 0) await treasury.midnight(now);
    // Price: a random walk, with a crash on day 20 and a pump on day 22.
    priceUsd *= 1 + (r() - 0.5) * 0.04;
    if (day === 20 && hod === 0) priceUsd *= 0.5;
    if (day === 22 && hod === 0) priceUsd *= 2.5;
    const vol = dayVolume(day, r) * hourShare(hod);
    chain.accrue(usdToRaw(vol * 0.03, price()));
    // Fee claims fail for eight hours on day 10 (invariant 7).
    chain.claimFails = day === 10 && hod < 8;
    if (chain.claimFails) outageHours.push(h);
    await treasury.claimTick(now + 60_000);
    const afterSweep = { hot: chain.hot, keep: (treasury.state?.hotTarget ?? 0n) + (await ledger.window(now + 60_000)).outstanding };
    await treasury.recompute(now + 120_000);

    // Matches: proportional to volume, plus a floor of regulars.
    const n = Math.round(vol / 300 + 10 * hourShare(hod) * 24);
    const whaleGames = day >= 3 && day < 27 ? 7 : 0; // ~170 a day: more than the 40 paid wins allow
    const botBurst = day === 15 && hod === 12 ? 2000 : 0;
    for (let i = 0; i < n + whaleGames + botBurst; i++) {
      const at = now + 120_000 + Math.floor(r() * 55) * 60_000;
      let winner: string, loser: string, tier: PayTier, q = 10000;
      if (i >= n + whaleGames) {
        winner = pick(bots);
        loser = pick(bots);
        if (winner === loser) continue;
        tier = "rust";
      } else if (i >= n) {
        tier = "gold";
        const other = pick(players.gold);
        [winner, loser] = r() < 0.8 ? [whale, other] : [other, whale];
      } else {
        tier = tierOf();
        // Cross-tier now and then: the match pays the lower tier.
        const other = r() < 0.15 ? tierOf() : tier;
        winner = pick(players[tier]);
        loser = pick(players[other]);
        if (winner === loser) continue;
        tier = other === "rust" || tier === "rust" ? "rust" : other === "chrome" || tier === "chrome" ? "chrome" : "gold";
        const x = r();
        q = x < 0.03 ? 0 : x < 0.08 ? 5000 : 10000;
      }
      await ledger.bookWin({ matchId: `m-${matchN++}`, endedAt: at, winner, loser, tier, qualityBps: q });
    }

    // A crash between sign and send on day 8: three rows are signed, never broadcast.
    if (day === 8 && hod === 3) {
      chain.dropSubmits = true;
      await treasury.payPass(now + 59 * 60_000);
      chain.dropSubmits = false;
      for (const p of ledger.payouts) if (p.status === "sent" && chain.unsent.has(p.sig ?? "")) crashRows.push(p.id);
      treasury = mk(treasury); // a fresh process
      await treasury.reconcile(now + 59 * 60_000 + 1);
    }
    await treasury.payPass(now + 59 * 60_000 + 2);
    // Sammy clears a cap pause two hours after the alert.
    const ps = await ledger.pause();
    if (ps.paused && !(day === 15 && hod < 14)) await ledger.setPause(false, null);
    hours.push({ at: now + HOUR_MS, hot: chain.hot, hotAfterSweep: afterSweep.hot, keep: afterSweep.keep, allowance: ledger.allowance, pausedAt: ps.paused });
  }
  return { params, ledger, chain, alerts, treasury, hours, whale, bots, outageHours, crashRows, dust };
}

const sum = (xs: Iterable<bigint>) => [...xs].reduce((a, b) => a + b, 0n);
const sentOrPaid = (p: SimPayout) => p.status === "sent" || p.status === "paid";

describe("a synthetic month never runs dry", () => {
  let run: Run;
  it("runs", async () => {
    run = await runMonth({ seedUsd: 5000, gWinUsd: 500, gDailyUsd: 200 });
    expect(run.ledger.matches.length).toBeGreaterThan(20_000);
    expect(run.ledger.payouts.filter((p) => p.status === "paid").length).toBeGreaterThan(5000);
  }, 120_000);

  it("invariant 1: nothing is paid that fees or the seed did not bring in, by the ledger's own count", () => {
    const { ledger, chain, hours, dust } = run;
    // Cumulative: every token paid to a player came from the player share or a seed draw.
    const paid = sum(ledger.payouts.filter(sentOrPaid).map((p) => p.amount));
    const received = sum(ledger.claims.map((c) => c.playerShare)) + sum([...ledger.seedDraws.values()].map((s) => s.draw.total));
    expect(paid).toBeLessThanOrEqual(received);
    // The ledger allowance never went negative, and the chain agrees with it to the base unit.
    for (const h of hours) expect(h.allowance, new Date(h.at).toISOString()).toBeGreaterThanOrEqual(0n);
    expect(chain.hot).toBe(ledger.allowance + dust);
    expect(sum(chain.balances.values())).toBe(sum(ledger.payouts.filter(sentOrPaid).map((p) => p.amount)));
    expect(chain.cold).toBe(sum(ledger.sweeps.map((s) => s.amount)));
    // What players got over the month is about the player share of fees: not more, and not hoarded.
    const share = sum(ledger.claims.map((c) => c.playerShare));
    expect(Number(paid) / Number(share)).toBeGreaterThan(0.35);
  });

  it("invariant 2: the seed draws at most 1/14 of the original per day and never overdraws", () => {
    const { ledger, params } = run;
    const perDay = ledger.seedBalance.original / BigInt(params.seedDrawDivisor);
    let total = 0n;
    for (const [day, s] of ledger.seedDraws) {
      expect(s.draw.total, day).toBeLessThanOrEqual(perDay);
      expect(s.draw.win + s.draw.daily).toBe(s.draw.total);
      total += s.draw.total;
    }
    expect(total).toBeLessThanOrEqual(ledger.seedBalance.original);
    expect(ledger.seedBalance.remaining).toBe(ledger.seedBalance.original - total);
    expect(run.chain.seedWallet).toBe(ledger.seedBalance.remaining);
    // Launch days had fees above the guarantees: nothing drawn. Dead days drew.
    expect(ledger.seedDraws.get("2026-10-02")?.draw.total).toBe(0n);
    expect(ledger.seedDraws.get("2026-10-14")?.draw.total ?? 0n).toBeGreaterThan(0n);
  });

  it("invariant 3 (pot model): player money stays in the hot wallet: nothing is swept, and the wallet covers the allowance", () => {
    const { chain, hours } = run;
    expect(chain.sweeps.length).toBe(0);
    expect(chain.cold).toBe(0n);
    for (const h of hours) expect(h.hot, new Date(h.at).toISOString()).toBeGreaterThanOrEqual(h.allowance);
  });

  it("invariant 4: the USD caps hold per payout, hour and day, and a cap hit paused payouts with an alert", () => {
    const { ledger, params, alerts } = run;
    const sent = ledger.payouts.filter(sentOrPaid);
    for (const p of sent) {
      expect(rawToUsd(p.amount, { usd: p.sentPriceUsd ?? 0, decimals: DECIMALS }), p.idemKey).toBeLessThanOrEqual((p.kind === "win" ? params.maxPayoutUsd : params.maxDailyRewardUsd) + 1e-6);
    }
    // The caps are checked in raw units at the price of the moment; over a
    // day the price moves, so the bound in raw units is the cap at the day's
    // lowest price (the most raw units a dollar cap ever allowed).
    const byHour = new Map<number, { raw: bigint; minPrice: number }>();
    const byDay = new Map<string, { raw: bigint; minPrice: number }>();
    for (const p of sent) {
      const price = p.sentPriceUsd ?? 0;
      const hr = Math.floor((p.sentAt ?? 0) / HOUR_MS);
      if (p.kind === "win") {
        const b = byHour.get(hr) ?? { raw: 0n, minPrice: Infinity };
        byHour.set(hr, { raw: b.raw + p.amount, minPrice: Math.min(b.minPrice, price) });
      }
      const d = utcDay(p.sentAt ?? 0);
      const b = byDay.get(d) ?? { raw: 0n, minPrice: Infinity };
      byDay.set(d, { raw: b.raw + p.amount, minPrice: Math.min(b.minPrice, price) });
    }
    for (const [hr, b] of byHour) expect(b.raw, `hour ${hr}`).toBeLessThanOrEqual(usdToRaw(params.maxHourlyUsd, { usd: b.minPrice, decimals: DECIMALS }));
    for (const [d, b] of byDay) expect(b.raw, d).toBeLessThanOrEqual(usdToRaw(params.maxDailyUsd, { usd: b.minPrice, decimals: DECIMALS }));
    expect(alerts.sent.some((a) => a.kind === "pause")).toBe(true);
    expect(run.hours.some((h) => h.pausedAt)).toBe(true);
    expect(ledger.payouts.some((p) => p.lastError === "hourly" || p.lastError === "daily")).toBe(true);
  });

  it("invariant 5: idempotent: one payout per key, one per match, one per address per day; the crash paid nobody twice", () => {
    const { ledger, chain, crashRows } = run;
    const keys = new Set(ledger.payouts.map((p) => p.idemKey));
    expect(keys.size).toBe(ledger.payouts.length);
    const perMatch = new Map<string, number>();
    for (const p of ledger.payouts) if (p.matchId) perMatch.set(p.matchId, (perMatch.get(p.matchId) ?? 0) + 1);
    for (const [m, n] of perMatch) expect(n, m).toBe(1);
    const perDayAddr = new Set<string>();
    for (const p of ledger.payouts) {
      if (p.kind !== "daily") continue;
      const k = `${p.day}:${p.to}`;
      expect(perDayAddr.has(k), k).toBe(false);
      perDayAddr.add(k);
    }
    // Signed-but-unsent rows were retried after the restart and landed once.
    expect(crashRows.length).toBeGreaterThan(0);
    const landedByMemo = new Map<string, number>();
    for (const t of chain.landed.values()) landedByMemo.set(t.memo, (landedByMemo.get(t.memo) ?? 0) + 1);
    const byId = new Map(ledger.payouts.map((p) => [p.id, p]));
    for (const rowId of crashRows) {
      const p = byId.get(rowId) as SimPayout;
      expect(p.status).toBe("paid");
      expect(p.attempts).toBe(1);
      expect(landedByMemo.get(p.idemKey)).toBe(1);
    }
    // Every signature on the chain belongs to exactly one ledger row, and every row landed at most once.
    const bySig = new Map<string, SimPayout>();
    for (const p of ledger.payouts) {
      if (!p.sig) continue;
      expect(bySig.has(p.sig)).toBe(false);
      bySig.set(p.sig, p);
    }
    for (const [sig, t] of chain.landed) {
      if (!sig.startsWith("sig-")) continue;
      const row = bySig.get(sig);
      expect(row?.idemKey).toBe(t.memo);
      expect(row?.amount).toBe(t.amount);
    }
    for (const [memo, n] of landedByMemo) if (memo.startsWith("win:") || memo.startsWith("daily:")) expect(n, memo).toBe(1);
  });

  it("invariant 6: the hot wallet never went negative and no transfer bounced", () => {
    for (const h of run.hours) expect(h.hot).toBeGreaterThanOrEqual(0n);
    expect(run.ledger.payouts.filter((p) => p.status === "failed")).toEqual([]);
    expect(run.ledger.payouts.filter((p) => p.lastError?.startsWith("send error"))).toEqual([]);
  });

  it("invariant 7: payouts went on through the eight-hour claim outage from what was already in the pot", () => {
    const { ledger, outageHours, alerts } = run;
    expect(outageHours.length).toBe(8);
    const during = ledger.payouts.filter((p) => sentOrPaid(p) && outageHours.some((h) => (p.sentAt ?? 0) >= T0 + h * HOUR_MS && (p.sentAt ?? 0) < T0 + (h + 1) * HOUR_MS));
    expect(during.length).toBeGreaterThan(5);
    // One alert on the third failure in a row (single drops are routine), and one when claims recover.
    const failed = alerts.sent.filter((a) => a.kind === "claim_failed");
    expect(failed.length).toBe(1);
    expect(failed[0]?.message).toMatch(/^3 fee claims in a row failed/);
    expect(alerts.sent.some((a) => a.kind === "info" && /working again after 8 failed/.test(a.message))).toBe(true);
    // Nothing was claimed in those hours, and the vault was caught up afterwards.
    expect(ledger.claims.some((c) => outageHours.some((h) => c.at >= T0 + h * HOUR_MS && c.at < T0 + (h + 1) * HOUR_MS))).toBe(false);
    expect(run.chain.vault).toBe(0n);
  });

  it("per-wallet caps: the whale is paid at most 40 wins a day and 10 against the same opponent; flagged bots get nothing", () => {
    const { ledger, whale, bots, params } = run;
    for (let d = 0; d < DAYS; d++) {
      const day = utcDay(T0 + d * DAY_MS);
      const wins = ledger.paidWinsOn(day);
      for (const [addr, n] of wins) expect(n, `${addr} on ${day}`).toBeLessThanOrEqual(params.maxPaidWinsPerDay);
      const pairs = new Map<string, number>();
      for (const m of ledger.matches) {
        if (m.booked === 0n || utcDay(m.endedAt) !== day) continue;
        const k = [m.winner, m.loser].sort().join("|");
        pairs.set(k, (pairs.get(k) ?? 0) + 1);
      }
      for (const [k, n] of pairs) expect(n, `${k} on ${day}`).toBeLessThanOrEqual(params.maxPaidVsSameOpponentPerDay);
    }
    const whaleGames = ledger.matches.filter((m) => m.winner === whale).length;
    const whalePaid = ledger.matches.filter((m) => m.winner === whale && m.booked > 0n).length;
    expect(whaleGames).toBeGreaterThan(whalePaid);
    for (const b of bots.slice(0, 5)) expect(ledger.payouts.some((p) => p.to === b)).toBe(false);
    for (const p of ledger.payouts) expect(p.amount).toBeGreaterThan(0n);
  });

  it("the daily top 10 is paid the 25/18/13/10/8/7/6/5/4/4 split of the closed day's pool", () => {
    const { ledger, params } = run;
    expect(ledger.dailies.size).toBe(DAYS); // the boot reconcile books the (empty) day before launch too
    for (const [day, d] of ledger.dailies) {
      const ranking = ledger.matches.filter((m) => utcDay(m.endedAt) === day && !ledger.flagged.has(m.winner));
      const total = sum(d.rewards.map((r) => r.amount));
      expect(total, day).toBeLessThanOrEqual(d.pool);
      d.rewards.forEach((r, i) => {
        expect(r.rank).toBe(i + 1);
        expect(r.shareBps).toBe(params.dailySplitBps[i]);
        expect(r.amount).toBe((d.pool * BigInt(r.shareBps)) / 10_000n);
        expect(ledger.flagged.has(r.address)).toBe(false);
      });
      if (ranking.length > 0 && d.pool > 0n) {
        expect(d.rewards.length).toBeGreaterThan(0);
        // Ranks are in non-increasing wins.
        for (let i = 1; i < d.rewards.length; i++) expect((d.rewards[i] as { wins: number }).wins).toBeLessThanOrEqual((d.rewards[i - 1] as { wins: number }).wins);
      }
    }
  });

  it("tiers pay their share of the pot (Rust 5%, Chrome 8%, Gold 12%) and cross-tier matches paid the lower tier", () => {
    const { ledger, params } = run;
    for (const { state } of ledger.states) {
      for (const t of ["rust", "chrome", "gold"] as PayTier[]) {
        const share = (state.perWinBudget * BigInt(params.winPctBps[t])) / 10_000n; // after the last booking (takeWin keeps perWin in step)
        if (share > state.perWinMin[t] && share < state.perWinMax[t]) expect(state.perWin[t]).toBe(share);
        expect(state.perWin[t]).toBeLessThanOrEqual(state.perWinBudget);
        expect(state.perWin[t]).toBeLessThanOrEqual(state.perWinMax[t]);
      }
    }
    const cross = ledger.matches.filter((m) => m.winner.startsWith("gold") && m.loser.startsWith("rust") && m.booked > 0n);
    expect(cross.length).toBeGreaterThan(0);
    expect(cross.every((m) => m.tier === "rust")).toBe(true);
  });

  it("the reserve holds: once the pot has been worth $500, wins never take it below $100", () => {
    const { ledger, params } = run;
    let armed = false;
    for (const { state, available } of ledger.states) {
      armed ||= state.peakUsd >= params.reserveArmUsd;
      if (!armed) continue;
      expect(state.reserve).toBe(usdToRaw(params.reserveUsd, state.price));
      expect(available).toBe(state.pot > state.reserve ? state.pot - state.reserve : 0n);
    }
    expect(armed).toBe(true);
    // The wins booked against one pool state never exceed what it had available above the reserve.
    for (const { at, available } of ledger.states) {
      const booked = sum(ledger.matches.filter((m) => m.bookedAt === at).map((m) => m.booked));
      expect(booked).toBeLessThanOrEqual(available);
    }
  });

  it("prizes track fees: the launch spike pays more per win than the quiet weeks", () => {
    const { ledger } = run;
    const at = (day: number, hour: number) => ledger.states.filter((s) => s.at >= T0 + day * DAY_MS + hour * HOUR_MS).map((s) => s.state)[0];
    const spike = at(2, 20) as { perWin: Record<PayTier, bigint>; price: Price };
    const quiet = at(18, 20) as { perWin: Record<PayTier, bigint>; price: Price };
    expect(rawToUsd(spike.perWin.rust, spike.price)).toBeGreaterThan(rawToUsd(quiet.perWin.rust, quiet.price));
  });

});

describe("a month with no seed and no guarantees still never overpays", () => {
  it("pays only from fees, from the first day, and never fails a payout", async () => {
    const run = await runMonth({ seedUsd: 0, gWinUsd: 0, gDailyUsd: 0, seed: 11 });
    const paid = sum(run.ledger.payouts.filter(sentOrPaid).map((p) => p.amount));
    expect(paid).toBeLessThanOrEqual(sum(run.ledger.claims.map((c) => c.playerShare)));
    for (const h of run.hours) expect(h.hot).toBeGreaterThanOrEqual(0n);
    expect(run.ledger.seedDraws.size).toBe(DAYS);
    for (const s of run.ledger.seedDraws.values()) expect(s.draw.total).toBe(0n);
    expect(run.ledger.payouts.some((p) => p.kind === "win" && sentOrPaid(p) && (p.sentAt ?? Infinity) < T0 + DAY_MS)).toBe(true);
    expect(run.ledger.payouts.filter((p) => p.status === "failed")).toEqual([]);
  }, 120_000);

});
