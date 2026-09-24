import { describe, expect, it } from "vitest";
import { runReplay, stateHash } from "@cockfight/sim";
import { BLEND_SPEED } from "../src/client";
import { simulate, type SimOptions } from "./harness";

function run(o: SimOptions) {
  const r = simulate(o);
  const secs = r.server.tick / 60;
  const per = r.clients.map((c) => ({
    snaps: c.stats.corrections.filter((x) => x.snapped).length,
    corrections: c.stats.corrections.length,
    maxDepth: c.stats.maxDepth,
    blendStep: c.stats.maxBlendStep,
    desyncs: c.stats.desyncs,
  }));
  return { r, secs, per };
}

describe("netcode over a simulated network", () => {
  it("80 ms RTT (the spec's acceptance): converges, never desyncs, no teleports", () => {
    const { r, per } = run({ rttMs: 80, jitterMs: 8, seconds: 90, hz: [60, 59.9], bots: ["hard", "mash"] });
    expect(r.converged).toEqual([true, true]);
    for (const p of per) {
      expect(p.desyncs).toBe(0);
      // No visible warping: nothing snaps, and a blended correction moves a
      // drawn chicken less per frame than a dash does (160 mu).
      expect(p.snaps).toBe(0);
      expect(p.blendStep).toBeLessThanOrEqual(BLEND_SPEED);
      expect(p.maxDepth).toBeLessThanOrEqual(9);
    }
    expect(r.server.quality(0)).toBeGreaterThan(0.99);
    expect(r.server.quality(1)).toBeGreaterThan(0.99);
    // The server's log replays to its exact final state.
    expect(runReplay(r.server.toReplay()).hash).toBe(stateHash(r.server.state));
  });

  it("different cities: 40 ms and 160 ms RTT with heavy jitter still converge", () => {
    for (const rttMs of [40, 160]) {
      const { r, per } = run({ rttMs, jitterMs: 25, seconds: 60, hz: [59.94, 60.05], seed: rttMs });
      expect(r.converged).toEqual([true, true]);
      expect(per.map((p) => p.desyncs)).toEqual([0, 0]);
      expect(runReplay(r.server.toReplay()).hash).toBe(stateHash(r.server.state));
    }
  });

  it("a 600 ms network stall costs inputs (counted) and the match recovers", () => {
    const { r, per } = run({ rttMs: 80, jitterMs: 5, seconds: 60, stalls: [[20_000, 20_600]], seed: 7 });
    expect(r.converged).toEqual([true, true]);
    expect(per.map((p) => p.desyncs)).toEqual([0, 0]);
    const st = r.server.stats;
    expect(st[0].missed + st[1].missed).toBeGreaterThan(0);
    expect(st[0].late + st[1].late).toBeGreaterThan(0);
    expect(r.server.quality(0)).toBeLessThan(1);
    expect(r.server.quality(0)).toBeGreaterThan(0.9);
  });
});
