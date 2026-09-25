/**
 * Economy params: env gives the defaults, the settings table (/admin) overrides
 * them at runtime. Read every minute; a bad override is ignored with a log line.
 */
import { DEFAULT_PARAMS, validateParams, type EconomyParams } from "@cockfight/economy";
import type { WorkerEnv } from "@cockfight/shared/env";

export function paramsFromEnv(env: WorkerEnv): EconomyParams {
  const [rust, chrome, gold] = env.TIER_WEIGHTS;
  const p: EconomyParams = {
    ...DEFAULT_PARAMS,
    playerShareBps: env.PLAYER_SHARE_BPS,
    dailyPoolBps: env.DAILY_POOL_BPS,
    tierWeightsMilli: { rust: Math.round(rust * 1000), chrome: Math.round(chrome * 1000), gold: Math.round(gold * 1000) },
    wFloorMilli: env.PAYOUT_W_FLOOR * 1000,
    pMinUsd: env.PAYOUT_P_MIN_USD,
    pMaxUsd: env.PAYOUT_P_MAX_USD,
    seedDrawDivisor: env.SEED_DAILY_DRAW_DIVISOR,
    gWinUsd: env.GUARANTEED_WIN_BUDGET_USD,
    gDailyUsd: env.GUARANTEED_DAILY_POOL_USD,
    maxPayoutUsd: env.MAX_PAYOUT_USD,
    maxDailyRewardUsd: env.MAX_DAILY_REWARD_USD,
    maxHourlyUsd: env.MAX_HOURLY_USD,
    maxDailyUsd: env.MAX_DAILY_USD,
  };
  validateParams(p);
  return p;
}

/** settings.key → params field, for the numeric knobs /admin may set. */
export const SETTING_KEYS: Record<string, keyof EconomyParams> = {
  p_min_usd: "pMinUsd",
  p_max_usd: "pMaxUsd",
  g_win_usd: "gWinUsd",
  g_daily_usd: "gDailyUsd",
  max_payout_usd: "maxPayoutUsd",
  max_daily_reward_usd: "maxDailyRewardUsd",
  max_hourly_usd: "maxHourlyUsd",
  max_daily_usd: "maxDailyUsd",
  w_floor: "wFloorMilli",
};

/** Apply the settings rows over the env params. Returns the merged params, or the base when the result is invalid. */
export function applySettings(base: EconomyParams, settings: Record<string, unknown>, log: (l: string) => void = console.warn): EconomyParams {
  const out: EconomyParams = { ...base, tierWeightsMilli: { ...base.tierWeightsMilli } };
  for (const [key, field] of Object.entries(SETTING_KEYS)) {
    const v = settings[key];
    if (v === undefined || v === null) continue;
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    if (!Number.isFinite(n) || n < 0) {
      log(`[settings] ignoring ${key}=${JSON.stringify(v)}`);
      continue;
    }
    (out as unknown as Record<string, number>)[field] = field === "wFloorMilli" ? Math.round(n * 1000) : n;
  }
  try {
    validateParams(out);
    return out;
  } catch (e) {
    log(`[settings] overrides rejected, keeping env defaults: ${e instanceof Error ? e.message : e}`);
    return base;
  }
}
