/**
 * Automatic pot top-ups: PUMP that lands in the hot wallet outside the ledger
 * (Sammy's deposits, fees someone else distributed) is booked into the pot by
 * the treasury, never more than the wallet holds, and never while a payout is
 * in flight.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS, Treasury, usdToRaw, type Price } from "../src";
import { MemoryAlerts, MemoryChain, MemoryLedger } from "./simulator";

const T0 = Date.parse("2026-10-03T12:00:00Z");
const price = (): Price => ({ usd: 0.005, decimals: 6 });
const pump = (usd: number) => usdToRaw(usd, price());

function setup(autoTopUp = true) {
  const params = { ...DEFAULT_PARAMS, gWinUsd: 0, gDailyUsd: 0 };
  const ledger = new MemoryLedger(params, price);
  const chain = new MemoryChain({ price, playerShareBps: params.playerShareBps, cold: false });
  const alerts = new MemoryAlerts();
  const treasury = new Treasury({ params, ledger, chain, alerts, autoTopUp, now: () => T0 });
  return { params, ledger, chain, alerts, treasury };
}

describe("automatic pot top-ups", () => {
  it("books a deposit once, says so, and the next win pays from it", async () => {
    const { ledger, chain, alerts, treasury } = setup();
    await treasury.reconcile(T0);
    chain.hot += pump(30); // Sammy sends $30 of PUMP to the hot wallet
    expect(await treasury.syncPot(T0)).toBe(pump(30));
    expect(ledger.allowance).toBe(chain.hot);
    expect(ledger.topups).toHaveLength(1);
    expect(alerts.sent.at(-1)?.message).toMatch(/^added 6,000 PUMP \(~\$30\.00\) to the prize pot/);
    expect(await treasury.syncPot(T0 + 60_000)).toBe(0n);
    expect(ledger.topups).toHaveLength(1);
    const s = await treasury.recompute(T0 + 60_000);
    expect(s.perWin.rust).toBeGreaterThan(0n);
  });

  it("claimTick books it when autoTopUp is on, and leaves it alone when off", async () => {
    const on = setup(true);
    on.chain.hot += pump(10);
    await on.treasury.claimTick(T0);
    expect(on.ledger.allowance).toBe(pump(10));
    const off = setup(false);
    off.chain.hot += pump(10);
    await off.treasury.claimTick(T0);
    expect(off.ledger.allowance).toBe(0n);
  });

  it("does not count a claim twice: fees the worker claimed are already in the books", async () => {
    const { ledger, chain, treasury } = setup();
    chain.accrue(pump(100));
    chain.hot += pump(5); // and a deposit in the same minute
    await treasury.claimTick(T0);
    expect(ledger.allowance).toBe(chain.hot);
    expect(ledger.topups.reduce((a, t) => a + t.amount, 0n)).toBe(pump(5));
  });

  it("ignores a gap under the minimum ($0.25)", async () => {
    const { ledger, chain, treasury } = setup();
    chain.hot += pump(0.2);
    expect(await treasury.syncPot(T0)).toBe(0n);
    expect(ledger.allowance).toBe(0n);
  });

  it("waits while a payout is sent but unconfirmed (the wallet hasn't dropped yet)", async () => {
    const { ledger, chain, treasury } = setup();
    chain.hot += pump(50);
    await treasury.syncPot(T0);
    await treasury.recompute(T0);
    expect(await ledger.bookWin({ matchId: "m-1", endedAt: T0, winner: "alice", loser: "bob", tier: "rust", qualityBps: 10000 })).toBeGreaterThan(0n);
    chain.dropSubmits = true; // signed and marked sent, never lands
    const r = await treasury.payPass(T0 + 1000);
    chain.dropSubmits = false;
    expect(r.sent).toBe(1);
    chain.hot += pump(20); // a deposit while the payout is in flight
    expect(await treasury.syncPot(T0 + 2000)).toBe(0n);
    // The stuck transfer expires and goes back to pending; then the deposit is booked, exactly.
    await treasury.reconcile(T0 + 10 * 60_000);
    expect((await ledger.sentPayouts()).length).toBe(0);
    expect(await treasury.syncPot(T0 + 11 * 60_000)).toBe(pump(20));
    expect(ledger.allowance).toBe(chain.hot);
  });

  it("alerts once when the wallet holds less than the books, and books nothing", async () => {
    const { ledger, chain, alerts, treasury } = setup();
    chain.hot += pump(40);
    await treasury.syncPot(T0);
    chain.hot -= pump(15); // moved out by hand
    const before = ledger.allowance;
    expect(await treasury.syncPot(T0 + 60_000)).toBe(0n);
    expect(await treasury.syncPot(T0 + 120_000)).toBe(0n);
    expect(ledger.allowance).toBe(before);
    expect(alerts.sent.filter((a) => /less than the books/.test(a.message))).toHaveLength(1);
  });

  it("never overlaps a pay pass", async () => {
    const { ledger, chain, treasury } = setup();
    chain.hot += pump(50);
    await treasury.syncPot(T0);
    await treasury.recompute(T0);
    for (let i = 0; i < 5; i++) await ledger.bookWin({ matchId: `m-${i}`, endedAt: T0, winner: `w${i}`, loser: `l${i}`, tier: "rust", qualityBps: 10000 });
    chain.hot += pump(7);
    const [pay, sync] = await Promise.all([treasury.payPass(T0 + 1000), treasury.syncPot(T0 + 1000)]);
    expect(pay.sent).toBeGreaterThan(0);
    // Either it ran before the pass (booked the 7) or after it (rows confirmed next pass, so it waited).
    if (sync === 0n) {
      await treasury.payPass(T0 + 2000);
      expect(await treasury.syncPot(T0 + 3000)).toBe(pump(7));
    } else {
      expect(sync).toBe(pump(7));
    }
    expect(ledger.allowance).toBe(chain.hot);
  });
});
