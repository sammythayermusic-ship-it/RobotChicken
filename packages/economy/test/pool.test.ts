import { describe, expect, it } from "vitest";
import {
  DEFAULT_PARAMS, capHit, computePoolState, dailyRewards, decideSend, lowerTier, payTier, qualityBps, rawToUsd, seedDraw,
  takeWin, usdToRaw, validateParams, type Price,
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

describe("the pot (Sammy, 2026-10-01)", () => {
  const inp = (o: { allowance?: number; outstanding?: number; grossToday?: number; peakUsd?: number }) => ({
    gross24h: 0n,
    grossToday: usd(o.grossToday ?? 0),
    seedWinTopUp: 0n,
    seedDailyTopUp: 0n,
    weighted24hMilli: 0n,
    allowance: usd(o.allowance ?? 0),
    outstanding: usd(o.outstanding ?? 0),
    peakUsd: o.peakUsd ?? 0,
    price,
  });

  it("a $30 starting pot pays a Rust win $1.50, Chrome $2.40, Gold $3.60 at once", () => {
    const s = computePoolState(inp({ allowance: 30 }), P);
    expect(rawToUsd(s.perWin.rust, price)).toBeCloseTo(1.5, 6);
    expect(rawToUsd(s.perWin.chrome, price)).toBeCloseTo(2.4, 6);
    expect(rawToUsd(s.perWin.gold, price)).toBeCloseTo(3.6, 6);
    expect(s.reserve).toBe(0n);
  });

  it("holds $100 back once the pot has been worth $500: $500 → $400 available → Rust $20, Chrome $32, Gold $48", () => {
    const s = computePoolState(inp({ allowance: 500 }), P);
    expect(s.peakUsd).toBeCloseTo(500, 6);
    expect(rawToUsd(s.reserve, price)).toBeCloseTo(100, 6);
    expect(rawToUsd(s.perWinBudget, price)).toBeCloseTo(400, 6);
    expect(rawToUsd(s.perWin.rust, price)).toBeCloseTo(20, 6);
    expect(rawToUsd(s.perWin.chrome, price)).toBeCloseTo(32, 6);
    expect(rawToUsd(s.perWin.gold, price)).toBeCloseTo(48, 6);
    // Later the pot falls to $120: only $20 is available, and it never pays into the $100.
    const low = computePoolState(inp({ allowance: 120, peakUsd: s.peakUsd }), P);
    expect(rawToUsd(low.perWinBudget, price)).toBeCloseTo(20, 6);
    const below = computePoolState(inp({ allowance: 90, peakUsd: s.peakUsd }), P);
    expect(below.perWinBudget).toBe(0n);
    expect(below.perWin.gold).toBe(0n);
  });

  it("keeps today's daily top-10 pool and booked payouts out of the pot", () => {
    // $1,000 of fees today → $100 daily pool (10%); $50 booked, not yet sent.
    const s = computePoolState(inp({ allowance: 400, outstanding: 50, grossToday: 1000 }), P);
    expect(rawToUsd(s.dailyPool, price)).toBeCloseTo(100, 6);
    expect(rawToUsd(s.pot, price)).toBeCloseTo(250, 6);
  });

  it("each booked win comes off the pot at once, so a burst of wins can never overspend it", () => {
    const s = computePoolState(inp({ allowance: 30 }), P);
    let total = 0n;
    const first = takeWin(s, "rust", 10000);
    expect(rawToUsd(first, price)).toBeCloseTo(1.5, 6);
    total += first;
    const second = takeWin(s, "rust", 10000);
    expect(rawToUsd(second, price)).toBeCloseTo(1.425, 6); // 5% of $28.50
    total += second;
    for (let i = 0; i < 500; i++) total += takeWin(s, "gold", 10000);
    expect(total).toBeLessThanOrEqual(usd(30));
    expect(s.perWinBudget).toBeGreaterThanOrEqual(0n);
  });

  it("clamps to the floor while there is that much, and to the cap", () => {
    // $10 available: 5% would be $0.50, the floor lifts it to $0.75.
    const s = computePoolState(inp({ allowance: 10 }), P);
    expect(rawToUsd(s.perWin.rust, price)).toBeCloseTo(0.75, 6);
    // $0.40 left: the win pays what is there, never more.
    const tiny = computePoolState(inp({ allowance: 0.4 }), P);
    expect(rawToUsd(tiny.perWin.rust, price)).toBeCloseTo(0.4, 6);
    // $100k available: Rust caps at $75, Gold at $450.
    const rich = computePoolState(inp({ allowance: 100_100, peakUsd: 1000 }), P);
    expect(rawToUsd(rich.perWin.rust, price)).toBeCloseTo(75, 6);
    expect(rawToUsd(rich.perWin.gold, price)).toBeCloseTo(450, 6);
  });

  it("applies the quality multiplier", () => {
    expect(qualityBps({ dropRate: 0.05, reason: "ko", durationS: 90 })).toBe(10000);
    expect(qualityBps({ dropRate: 0.2, reason: "ko", durationS: 90 })).toBe(5000);
    expect(qualityBps({ dropRate: 0.31, reason: "ko", durationS: 90 })).toBe(0);
    expect(qualityBps({ dropRate: 0, reason: "forfeit", durationS: 20 })).toBe(0);
    expect(qualityBps({ dropRate: 0, reason: "forfeit", durationS: 45 })).toBe(10000);
    expect(qualityBps({ dropRate: NaN, reason: "ko", durationS: 45 })).toBe(0);
    const s = computePoolState({ gross24h: 0n, grossToday: 0n, seedWinTopUp: 0n, seedDailyTopUp: 0n, weighted24hMilli: 0n, allowance: usd(300), outstanding: 0n, peakUsd: 0, price }, P);
    const full = s.perWin.rust;
    expect(takeWin(s, "rust", 5000)).toBe(full / 2n);
    expect(takeWin(s, "gold", 0)).toBe(0n);
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
