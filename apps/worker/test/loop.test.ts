/** The schedule: a fee claim every CLAIM_EVERY_MIN minutes (10 by default), the pool every minute. */
import { describe, expect, it } from "vitest";
import type { Treasury } from "@cockfight/economy";
import type { SupabaseLedger } from "../src/ledger";
import { WorkerLoop } from "../src/loop";
import type { WorkerStatus } from "../src/server";

function fakeTreasury() {
  const calls: string[] = [];
  const t = {
    state: null,
    reconcile: async () => void calls.push("reconcile"),
    claimTick: async () => void calls.push("claim"),
    refreshPrice: async () => void calls.push("price"),
    midnight: async () => ({ daily: 0, seed: null }),
    recompute: async () => void calls.push("recompute"),
    payPass: async () => ({ sent: 0, deferred: 0, confirmed: 0, retried: 0, failed: 0 }),
  };
  return { calls, treasury: t as unknown as Treasury };
}

async function runMinutes(mode: "live" | "observer", minutes: number, claimEveryMin?: number) {
  const { calls, treasury } = fakeTreasury();
  let now = Date.parse("2026-10-01T12:00:30Z");
  const status: WorkerStatus = { ok: true, mode: "health", payoutsEnabled: false, startedAt: "" };
  const loop = new WorkerLoop({ treasury, ledger: {} as SupabaseLedger, mode, status, reloadParams: async () => {}, now: () => now, claimEveryMin });
  await loop.start();
  loop.stop(); // no real timers: drive the minute tick by hand
  const tick = (loop as unknown as { minute(): Promise<void> }).minute.bind(loop);
  (loop as unknown as { stopped: boolean }).stopped = false;
  for (let i = 0; i < minutes; i++) {
    now += 60_000;
    await tick();
  }
  return { calls, status };
}

describe("worker schedule", () => {
  it("claims every 10 minutes by default: 6 claims in an hour, the pool every minute", async () => {
    const { calls, status } = await runMinutes("live", 60);
    expect(calls.filter((c) => c === "claim")).toHaveLength(6);
    expect(calls.filter((c) => c === "recompute")).toHaveLength(60);
    expect(status.lastClaimAt).toBe("2026-10-01T13:00:30.000Z");
  });

  it("follows CLAIM_EVERY_MIN, and the observer only refreshes the price on the same beat", async () => {
    expect((await runMinutes("live", 60, 5)).calls.filter((c) => c === "claim")).toHaveLength(12);
    const obs = await runMinutes("observer", 60);
    expect(obs.calls.filter((c) => c === "claim")).toHaveLength(0);
    expect(obs.calls.filter((c) => c === "price")).toHaveLength(6);
  });
});
