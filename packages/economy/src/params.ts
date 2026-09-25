/**
 * The knobs of the economy, in one object, with the defaults from
 * docs/plan-phase3.md. The worker builds this from env (`.env.example`) and
 * /admin overrides; the simulator builds it directly.
 *
 * Money in this package is always `bigint` raw base units of the payout token
 * (PUMP: 6 decimals). Dollar knobs are plain numbers and are converted at the
 * price the worker fetched that hour, so a price move changes the token
 * amounts, never the dollar value of a prize.
 */

/** Paying tiers. Diamond ($5k) is cosmetic in the spec and pays at Gold's weight. */
export type PayTier = "rust" | "chrome" | "gold";
export const PAY_TIERS: readonly PayTier[] = ["rust", "chrome", "gold"];

export interface EconomyParams {
  /** Of gross creator fees, what lands in the hot wallet for players (pump.fun's fee split). */
  playerShareBps: number;
  /** Of gross creator fees, the daily top-10 pool. The rest of the player share pays wins. */
  dailyPoolBps: number;
  /** Tier weights in thousandths (Rust 1.000, Chrome 2.500, Gold 6.000). */
  tierWeightsMilli: Record<PayTier, number>;
  /** W_floor: the per-win budget is divided by at least this many weighted matches. */
  wFloorMilli: number;
  /** Rust's floor and cap per win, USD. Other tiers scale by weight. */
  pMinUsd: number;
  pMaxUsd: number;
  /** The seed may be drawn down by at most original / this per UTC day. */
  seedDrawDivisor: number;
  /** Guaranteed daily per-win budget and daily pool, USD (0 = off). */
  gWinUsd: number;
  gDailyUsd: number;
  /**
   * Worker caps, USD. Any hit pauses payouts. Per win, per daily reward
   * (first place on a big day is many wins' worth), wins per hour (the
   * midnight top-10 batch is exempt), and everything per day.
   */
  maxPayoutUsd: number;
  maxDailyRewardUsd: number;
  maxHourlyUsd: number;
  maxDailyUsd: number;
  /** Daily pool split by rank, basis points, rank 1 first. Sums to 10000. */
  dailySplitBps: readonly number[];
  /** Per-wallet caps from the spec. */
  maxPaidWinsPerDay: number;
  maxPaidVsSameOpponentPerDay: number;
  /** Hot wallet target: this many days of the per-win budget plus today's daily pool. */
  hotDays: number;
}

export const DAILY_SPLIT_BPS: readonly number[] = [2500, 1800, 1300, 1000, 800, 700, 600, 500, 400, 400];

export const DEFAULT_PARAMS: EconomyParams = {
  playerShareBps: 7000,
  dailyPoolBps: 2000,
  tierWeightsMilli: { rust: 1000, chrome: 2500, gold: 6000 },
  wFloorMilli: 200_000,
  pMinUsd: 0.75,
  pMaxUsd: 75,
  seedDrawDivisor: 14,
  gWinUsd: 0,
  gDailyUsd: 0,
  maxPayoutUsd: 500,
  maxDailyRewardUsd: 5000,
  maxHourlyUsd: 3000,
  maxDailyUsd: 20000,
  dailySplitBps: DAILY_SPLIT_BPS,
  maxPaidWinsPerDay: 40,
  maxPaidVsSameOpponentPerDay: 10,
  hotDays: 1.5,
};

/** Throws on a parameter set that can't be solvent or can't be paid. */
export function validateParams(p: EconomyParams): void {
  const bad = (m: string) => {
    throw new Error(`economy params: ${m}`);
  };
  if (!(p.playerShareBps > 0 && p.playerShareBps <= 10000)) bad("playerShareBps must be in (0, 10000]");
  if (!(p.dailyPoolBps >= 0 && p.dailyPoolBps < p.playerShareBps)) bad("dailyPoolBps must be below playerShareBps");
  for (const t of PAY_TIERS) if (!(p.tierWeightsMilli[t] > 0)) bad(`tier weight ${t} must be positive`);
  if (p.tierWeightsMilli.rust > p.tierWeightsMilli.chrome || p.tierWeightsMilli.chrome > p.tierWeightsMilli.gold) bad("tier weights must not decrease");
  if (!(p.wFloorMilli > 0)) bad("wFloorMilli must be positive");
  if (!(p.pMinUsd >= 0 && p.pMaxUsd >= p.pMinUsd)) bad("0 <= pMinUsd <= pMaxUsd");
  if (!(p.seedDrawDivisor >= 1)) bad("seedDrawDivisor must be >= 1");
  if (!(p.gWinUsd >= 0 && p.gDailyUsd >= 0)) bad("guarantees must be >= 0");
  if (!(p.maxPayoutUsd > 0 && p.maxHourlyUsd >= p.maxPayoutUsd && p.maxDailyUsd >= p.maxHourlyUsd)) bad("caps must nest: payout <= hourly <= daily");
  if (!(p.maxDailyRewardUsd >= p.maxPayoutUsd && p.maxDailyUsd >= p.maxDailyRewardUsd)) bad("caps must nest: payout <= daily reward <= daily");
  if (p.maxPayoutUsd < p.pMaxUsd * (p.tierWeightsMilli.gold / 1000)) bad("maxPayoutUsd is below the Gold cap: every Gold win would pause payouts");
  const sum = p.dailySplitBps.reduce((a, b) => a + b, 0);
  if (sum !== 10000 || p.dailySplitBps.some((b) => b < 0)) bad("dailySplitBps must be >= 0 and sum to 10000");
  if (!(p.maxPaidWinsPerDay > 0 && p.maxPaidVsSameOpponentPerDay > 0)) bad("per-wallet caps must be positive");
  if (!(p.hotDays > 0)) bad("hotDays must be positive");
}

/** Which paying tier a holding tier maps to (diamond pays as gold). */
export function payTier(tier: string): PayTier {
  return tier === "chrome" ? "chrome" : tier === "gold" || tier === "diamond" ? "gold" : "rust";
}

const RANK: Record<PayTier, number> = { rust: 0, chrome: 1, gold: 2 };

/** A cross-tier match pays at the lower tier. */
export function lowerTier(a: string, b: string): PayTier {
  const x = payTier(a);
  const y = payTier(b);
  return RANK[x] <= RANK[y] ? x : y;
}
