import { describe, expect, it } from "vitest";
import {
  DEFAULT_PARAMS, capHit, computePoolState, dailyRewards, decideSend, lowerTier, payTier, qualityBps, rawToUsd, seedDraw,
  usdToRaw, validateParams, winAmount, type Price,
} from "../src";

const price: Price = { usd: 0.005, decimals: 6 };
const usd = (x: number) => usdToRaw(x, price);
const P = DEFAULT_PARAMS;

describe("money", () => {
  it("converts dollars to raw units and back without losing a memecoin's digits", () => {
    expect(usdToRaw(1, { usd: 0.005, decimals: 6 })).toBe(200_000_000n);
    expect(usdToRaw(0.75, { usd: 0.0000031, decimals: 6 })).toBe(241_935_483_870n);
    expect(rawToUsd(241_935_483_870n, { usd: 0.0000031, decimals: 6 })).toBeCloseTo(0.75, 6);
    expect(usdToRaw(10, { usd: 0, decimals: 6 })).toBe(0n);
    expect(usdToRaw(-1, price)).toBe(0n);
  });
});

describe("the per-win formula", () => {
  it("matches the plan's worked example: $15k of fees, 1,500 matches → Rust $2.90, Chrome $7.20, Gold $17.30", () => {
    // 1,000 Rust + 400 Chrome + 100 Gold = 1,000 + 1,000 + 600 = 2,600 weighted matches.
    const s = computePoolState(
      { gross24h: usd(15_000), grossToday: usd(15_000), seedWinTopUp: 0n, seedDailyTopUp: 0n, weighted24hMilli: 2_600_000n, price },
      P,
    );
    expect(rawToUsd(s.perWinBudget, price)).toBeCloseTo(7500, 2);
    expect(rawToUsd(s.perWin.rust, price)).toBeCloseTo(2.88, 1);
    expect(rawToUsd(s.perWin.chrome, price)).toBeCloseTo(7.21, 1);
    expect(rawToUsd(s.perWin.gold, price)).toBeCloseTo(17.3, 1);
    expect(rawToUsd(s.dailyPool, price)).toBeCloseTo(3000, 2);
    expect(rawToUsd(s.hotTarget, price)).toBeCloseTo(7500 * 1.5 + 3000, 2);
  });

  it("divides by at least W_floor so a thin day can't mint huge prizes, and clamps to the floor and cap", () => {
    const thin = computePoolState({ gross24h: usd(15_000), grossToday: 0n, seedWinTopUp: 0n, seedDailyTopUp: 0n, weighted24hMilli: 10_000n, price }, P);
    expect(thin.weightedMilli).toBe(200_000n);
    expect(rawToUsd(thin.perWin.rust, price)).toBeCloseTo(37.5, 2); // 7500 / 200
    const rich = computePoolState({ gross24h: usd(500_000), grossToday: 0n, seedWinTopUp: 0n, seedDailyTopUp: 0n, weighted24hMilli: 10_000n, price }, P);
    expect(rich.perWin.rust).toBe(rich.perWinMax.rust);
    expect(rawToUsd(rich.perWin.gold, price)).toBeCloseTo(450, 2);
    const dead = computePoolState({ gross24h: 0n, grossToday: 0n, seedWinTopUp: 0n, seedDailyTopUp: 0n, weighted24hMilli: 500_000n, price }, P);
    expect(dead.perWin.rust).toBe(dead.perWinMin.rust);
    expect(rawToUsd(dead.perWin.rust, price)).toBeCloseTo(0.75, 2);
    expect(rawToUsd(dead.perWin.gold, price)).toBeCloseTo(4.5, 2);
  });

  it("the seed top-up lifts a quiet day's budget", () => {
    const s = computePoolState({ gross24h: 0n, grossToday: 0n, seedWinTopUp: usd(500), seedDailyTopUp: usd(200), weighted24hMilli: 200_000n, price }, P);
    expect(rawToUsd(s.perWin.rust, price)).toBeCloseTo(2.5, 2);
    expect(rawToUsd(s.dailyPool, price)).toBeCloseTo(200, 2);
  });

  it("applies the quality multiplier", () => {
    expect(qualityBps({ dropRate: 0.05, reason: "ko", durationS: 90 })).toBe(10000);
    expect(qualityBps({ dropRate: 0.2, reason: "ko", durationS: 90 })).toBe(5000);
    expect(qualityBps({ dropRate: 0.31, reason: "ko", durationS: 90 })).toBe(0);
    expect(qualityBps({ dropRate: 0, reason: "forfeit", durationS: 20 })).toBe(0);
    expect(qualityBps({ dropRate: 0, reason: "forfeit", durationS: 45 })).toBe(10000);
    expect(qualityBps({ dropRate: NaN, reason: "ko", durationS: 45 })).toBe(0);
    const s = computePoolState({ gross24h: usd(15_000), grossToday: 0n, seedWinTopUp: 0n, seedDailyTopUp: 0n, weighted24hMilli: 2_600_000n, price }, P);
    expect(winAmount(s, "rust", 5000)).toBe(s.perWin.rust / 2n);
    expect(winAmount(s, "gold", 0)).toBe(0n);
  });

  it("maps holding tiers to paying tiers and pays a cross-tier match at the lower one", () => {
    expect(payTier("diamond")).toBe("gold");
    expect(payTier("nope")).toBe("rust");
    expect(lowerTier("gold", "rust")).toBe("rust");
    expect(lowerTier("chrome", "diamond")).toBe("chrome");
    expect(lowerTier("gold", "gold")).toBe("gold");
  });
});

describe("the daily pool", () => {
  it("splits 25/18/13/10/8/7/6/5/4/4 over the top 10, skipping winless and unpaid ranks", () => {
    const ranked = Array.from({ length: 12 }, (_, i) => ({ address: `p${i}`, wins: 20 - i }));
    const r = dailyRewards(usd(3000), ranked, P);
    expect(r.map((x) => x.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(rawToUsd(r[0]!.amount, price)).toBeCloseTo(750, 2);
    expect(rawToUsd(r[9]!.amount, price)).toBeCloseTo(120, 2);
    expect(r.reduce((a, x) => a + x.amount, 0n)).toBeLessThanOrEqual(usd(3000));
    expect(dailyRewards(usd(3000), [{ address: "a", wins: 3 }, { address: "b", wins: 0 }], P).length).toBe(1);
    expect(dailyRewards(0n, ranked, P)).toEqual([]);
  });
});

describe("the seed", () => {
  const seed = { seedOriginal: usd(5000), seedRemaining: usd(5000), price };
  it("draws nothing when fees cover the guarantees", () => {
    const d = seedDraw({ ...seed, gross24h: usd(15_000), grossDay: usd(15_000) }, { ...P, gWinUsd: 500, gDailyUsd: 200 });
    expect(d.total).toBe(0n);
  });
  it("draws the shortfall, at most 1/14 of the original, split between wins and the pool", () => {
    const d = seedDraw({ ...seed, gross24h: 0n, grossDay: 0n }, { ...P, gWinUsd: 500, gDailyUsd: 200 });
    expect(rawToUsd(d.shortfall, price)).toBeCloseTo(700, 2);
    expect(rawToUsd(d.total, price)).toBeCloseTo(5000 / 14, 2);
    expect(d.win + d.daily).toBe(d.total);
    expect(Number(d.win) / Number(d.total)).toBeCloseTo(5 / 7, 3);
    const late = seedDraw({ ...seed, seedRemaining: usd(100), gross24h: 0n, grossDay: 0n }, { ...P, gWinUsd: 500, gDailyUsd: 200 });
    expect(late.total).toBe(usd(100));
    const empty = seedDraw({ ...seed, seedRemaining: 0n, gross24h: 0n, grossDay: 0n }, { ...P, gWinUsd: 500, gDailyUsd: 200 });
    expect(empty.total).toBe(0n);
  });
  it("draws only the part the fees miss", () => {
    const d = seedDraw({ ...seed, gross24h: usd(600), grossDay: usd(600) }, { ...P, gWinUsd: 500, gDailyUsd: 200 });
    // wins have 300 of 500, the pool 120 of 200 → shortfall 280
    expect(rawToUsd(d.shortfall, price)).toBeCloseTo(280, 2);
    expect(rawToUsd(d.total, price)).toBeCloseTo(280, 2);
  });
});

describe("caps and the send decision", () => {
  const view = { sentLastHour: 0n, sentToday: 0n, price };
  it("names the cap a send would break", () => {
    expect(capHit(usd(499), "win", view, P)).toBeNull();
    expect(capHit(usd(501), "win", view, P)).toBe("per_payout");
    expect(capHit(usd(4999), "daily", view, P)).toBeNull();
    expect(capHit(usd(5001), "daily", view, P)).toBe("per_payout");
    expect(capHit(usd(10), "win", { ...view, sentLastHour: usd(2995) }, P)).toBe("hourly");
    expect(capHit(usd(4000), "daily", { ...view, sentLastHour: usd(2995) }, P)).toBeNull();
    expect(capHit(usd(10), "win", { ...view, sentToday: usd(19_995) }, P)).toBe("daily");
    expect(capHit(1n, "win", { ...view, price: { usd: 0, decimals: 6 } }, P)).toBe("per_payout");
  });
  it("defers on pause, allowance, caps and wallet cover, and only a cap hit pauses", () => {
    const ok = { ...view, allowance: usd(100), walletBalance: usd(100), paused: false };
    expect(decideSend(usd(10), "win", ok, P)).toEqual({ ok: true });
    expect(decideSend(usd(10), "win", { ...ok, paused: true }, P)).toEqual({ ok: false, defer: "paused", pause: false });
    expect(decideSend(usd(101), "win", ok, P)).toEqual({ ok: false, defer: "budget", pause: false });
    expect(decideSend(usd(10), "win", { ...ok, walletBalance: usd(5) }, P)).toEqual({ ok: false, defer: "wallet", pause: false });
    expect(decideSend(usd(10), "win", { ...ok, allowance: usd(50_000), walletBalance: usd(50_000), sentToday: usd(19_995) }, P)).toEqual({ ok: false, defer: "daily", pause: true });
  });
});

describe("params", () => {
  it("rejects a set that can't work", () => {
    expect(() => validateParams(P)).not.toThrow();
    expect(() => validateParams({ ...P, maxPayoutUsd: 75 })).toThrow(/Gold cap/);
    expect(() => validateParams({ ...P, dailySplitBps: [5000, 5001] })).toThrow(/10000/);
    expect(() => validateParams({ ...P, dailyPoolBps: 7000 })).toThrow(/dailyPoolBps/);
    expect(() => validateParams({ ...P, tierWeightsMilli: { rust: 1000, chrome: 900, gold: 6000 } })).toThrow(/decrease/);
  });
});
