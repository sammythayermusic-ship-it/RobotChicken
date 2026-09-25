/**
 * The pool maths from docs/plan-phase3.md, as pure functions.
 *
 *   B24   = gross creator fees claimed in the trailing 24 h
 *   D     = winShare × B24 + seedWinTopUp        (winShare = playerShare − dailyPool)
 *   W     = Σ weight(tier) over matches in the trailing 24 h
 *   base  = D / max(W, W_floor)
 *   p(t)  = clamp(base × w_t, P_min × w_t, P_max × w_t) × q
 *
 * Everything here is a function of ledger figures the worker reads from the
 * database; nothing reads a wallet balance (invariant 6). The worker
 * recomputes `PoolState` every minute and writes it to `pool_state`; the game
 * server books a win from that row at match end.
 */
import { bps, clampRaw, maxRaw, minRaw, usdToRaw, type Price } from "./money";
import { PAY_TIERS, type EconomyParams, type PayTier } from "./params";

export interface PoolInputs {
  /** Gross creator fees claimed in the trailing 24 h (raw). */
  gross24h: bigint;
  /** Gross creator fees claimed since 00:00 UTC (raw): the daily pool's base. */
  grossToday: bigint;
  /** Today's seed draw, split as seedDraw() decided (raw). */
  seedWinTopUp: bigint;
  seedDailyTopUp: bigint;
  /** Σ tier weights (thousandths) of matches in the trailing 24 h. */
  weighted24hMilli: bigint;
  price: Price;
}

export interface PoolState {
  /** D: today's per-win budget (raw). */
  perWinBudget: bigint;
  /** max(W, W_floor), thousandths. */
  weightedMilli: bigint;
  /** Raw per 1.000 of weight before the clamp. */
  base: bigint;
  /** What the next win pays per tier (raw, q = 1). */
  perWin: Record<PayTier, bigint>;
  /** Floor and cap per tier at this price (raw): the site can show the range. */
  perWinMin: Record<PayTier, bigint>;
  perWinMax: Record<PayTier, bigint>;
  /** Today's daily top-10 pool so far (raw). */
  dailyPool: bigint;
  /** Invariant 3: what the hot wallet should hold; the rest is swept to cold. */
  hotTarget: bigint;
  price: Price;
}

export function winShareBps(p: EconomyParams): number {
  return p.playerShareBps - p.dailyPoolBps;
}

export function computePoolState(inp: PoolInputs, p: EconomyParams): PoolState {
  const perWinBudget = bps(inp.gross24h, winShareBps(p)) + inp.seedWinTopUp;
  const weightedMilli = maxRaw(inp.weighted24hMilli, BigInt(p.wFloorMilli));
  const base = (perWinBudget * 1000n) / weightedMilli;
  const perWin = {} as Record<PayTier, bigint>;
  const perWinMin = {} as Record<PayTier, bigint>;
  const perWinMax = {} as Record<PayTier, bigint>;
  for (const t of PAY_TIERS) {
    const w = p.tierWeightsMilli[t];
    const lo = usdToRaw((p.pMinUsd * w) / 1000, inp.price);
    const hi = usdToRaw((p.pMaxUsd * w) / 1000, inp.price);
    perWinMin[t] = lo;
    perWinMax[t] = hi;
    perWin[t] = clampRaw((base * BigInt(w)) / 1000n, lo, hi);
  }
  const dailyPool = bps(inp.grossToday, p.dailyPoolBps) + inp.seedDailyTopUp;
  const hotTarget = (perWinBudget * BigInt(Math.round(p.hotDays * 1000))) / 1000n + dailyPool;
  return { perWinBudget, weightedMilli, base, perWin, perWinMin, perWinMax, dailyPool, hotTarget, price: inp.price };
}

/** The net-quality multiplier in basis points (spec): 1, 0.5 above 15% dropped inputs, 0 above 30% or for a forfeit under 30 s. */
export function qualityBps(q: { dropRate: number; reason: string; durationS: number }): 10000 | 5000 | 0 {
  if (q.reason === "forfeit" && q.durationS < 30) return 0;
  if (!(q.dropRate <= 0.3)) return 0;
  if (q.dropRate > 0.15) return 5000;
  return 10000;
}

/** What one win pays: the tier's current amount times the quality multiplier. */
export function winAmount(state: PoolState, tier: PayTier, quality: number): bigint {
  return bps(state.perWin[tier], quality);
}

export interface RankedPlayer {
  address: string;
  wins: number;
}

export interface DailyReward {
  rank: number;
  address: string;
  wins: number;
  shareBps: number;
  amount: bigint;
}

/** Split a closed day's pool over the top 10; fewer players leaves the missing ranks unpaid. */
export function dailyRewards(pool: bigint, ranked: readonly RankedPlayer[], p: EconomyParams): DailyReward[] {
  const out: DailyReward[] = [];
  ranked.slice(0, p.dailySplitBps.length).forEach((r, i) => {
    if (r.wins <= 0) return;
    const shareBps = p.dailySplitBps[i] as number;
    const amount = bps(pool, shareBps);
    if (amount > 0n) out.push({ rank: i + 1, address: r.address, wins: r.wins, shareBps, amount });
  });
  return out;
}

export interface SeedInputs {
  /** Gross claimed in the 24 h before the draw (the day that just closed). */
  gross24h: bigint;
  /** Gross claimed during the day that just closed. */
  grossDay: bigint;
  seedOriginal: bigint;
  seedRemaining: bigint;
  price: Price;
}

export interface SeedDraw {
  /** Toward the per-win budget and the daily pool (raw). */
  win: bigint;
  daily: bigint;
  total: bigint;
  /** The shortfall the guarantees asked for, before the 1/N and remaining caps. */
  shortfall: bigint;
}

/**
 * The seed draw booked at 00:00 UTC for the day ahead (invariant 2):
 *   shortfall = max(0, G_win − winShare × B24) + max(0, G_daily − dailyPool × B_day)
 *   draw      = min(shortfall, seedOriginal / N, seedRemaining)
 * Split between wins and the daily pool in proportion to their shortfalls.
 */
export function seedDraw(inp: SeedInputs, p: EconomyParams): SeedDraw {
  const none: SeedDraw = { win: 0n, daily: 0n, total: 0n, shortfall: 0n };
  if (inp.seedRemaining <= 0n || inp.seedOriginal <= 0n) return none;
  const winHave = bps(inp.gross24h, winShareBps(p));
  const dailyHave = bps(inp.grossDay, p.dailyPoolBps);
  const winShort = maxRaw(0n, usdToRaw(p.gWinUsd, inp.price) - winHave);
  const dailyShort = maxRaw(0n, usdToRaw(p.gDailyUsd, inp.price) - dailyHave);
  const shortfall = winShort + dailyShort;
  if (shortfall === 0n) return none;
  const perDay = inp.seedOriginal / BigInt(Math.max(1, Math.trunc(p.seedDrawDivisor)));
  const total = minRaw(shortfall, minRaw(perDay, inp.seedRemaining));
  const win = (total * winShort) / shortfall;
  return { win, daily: total - win, total, shortfall };
}

export interface BudgetView {
  /**
   * The ledger's allowance: every player share claimed plus every seed draw,
   * minus every payout sent and every sweep to cold. It is what the hot
   * wallet should hold, computed from the ledger alone (invariant 6), and a
   * payout may never take it below zero (invariant 1).
   */
  allowance: bigint;
}

/** Invariant 1: nothing is paid that claimed fees or the seed did not bring in, by the ledger's own count. */
export function withinBudget(amount: bigint, v: BudgetView): boolean {
  return amount <= v.allowance;
}

export interface CapsView {
  /** Wins sent in the trailing hour (daily rewards are exempt from the hourly cap). */
  sentLastHour: bigint;
  /** Everything sent since 00:00 UTC. */
  sentToday: bigint;
  price: Price;
}

export type CapHit = "per_payout" | "hourly" | "daily";

/** Invariant 4: the worker's USD caps. Returns which cap a send would break, or null. */
export function capHit(amount: bigint, kind: "win" | "daily", v: CapsView, p: EconomyParams): CapHit | null {
  const one = usdToRaw(kind === "win" ? p.maxPayoutUsd : p.maxDailyRewardUsd, v.price);
  const hour = usdToRaw(p.maxHourlyUsd, v.price);
  const day = usdToRaw(p.maxDailyUsd, v.price);
  // A missing price converts to 0: better to pause than to pay unpriced.
  if (amount > one) return "per_payout";
  if (kind === "win" && v.sentLastHour + amount > hour) return "hourly";
  if (v.sentToday + amount > day) return "daily";
  return null;
}

export interface SendView extends BudgetView, CapsView {
  /** The hot wallet's payout-token balance, read right before sending (invariant 6). */
  walletBalance: bigint;
  paused: boolean;
}

export type SendDecision = { ok: true } | { ok: false; defer: "paused" | "budget" | CapHit | "wallet"; pause: boolean };

/**
 * Whether one queued payout may be sent now. Anything that says no leaves the
 * row `deferred` for the next pass; a cap hit also pauses the queue and pings
 * Telegram (the worker does both from `pause`).
 */
export function decideSend(amount: bigint, kind: "win" | "daily", v: SendView, p: EconomyParams): SendDecision {
  if (v.paused) return { ok: false, defer: "paused", pause: false };
  if (!withinBudget(amount, v)) return { ok: false, defer: "budget", pause: false };
  const cap = capHit(amount, kind, v, p);
  if (cap) return { ok: false, defer: cap, pause: true };
  if (amount > v.walletBalance) return { ok: false, defer: "wallet", pause: false };
  return { ok: true };
}

/** Weighted match count for W: the lower tier of the pair, in thousandths. */
export function matchWeightMilli(tier: PayTier, p: EconomyParams): bigint {
  return BigInt(p.tierWeightsMilli[tier]);
}
