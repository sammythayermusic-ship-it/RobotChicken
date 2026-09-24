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

  it("different cities: 40, 160 and 300 ms RTT with heavy jitter still converge and keep their inputs", () => {
    for (const rttMs of [40, 160, 300]) {
      const { r, per } = run({ rttMs, jitterMs: 25, seconds: 60, hz: [59.94, 60.05], seed: rttMs });
      expect(r.converged).toEqual([true, true]);
      expect(per.map((p) => p.desyncs)).toEqual([0, 0]);
      expect(runReplay(r.server.toReplay()).hash).toBe(stateHash(r.server.state));
      expect(r.server.quality(0), `P1 input quality at ${rttMs} ms`).toBeGreaterThan(0.97);
      expect(r.server.quality(1), `P2 input quality at ${rttMs} ms`).toBeGreaterThan(0.97);
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

describe("presentation events", () => {
  it("rollbacks neither drop the hits the server saw nor show them twice", async () => {
    const { deriveEvents, RULES, createMatch, step, expandInputs } = await import("@cockfight/sim");
    const r = simulate({ rttMs: 80, jitterMs: 8, seconds: 60, hz: [60, 59.9], bots: ["hard", "mash"], seed: 3, collectEvents: true });
    // The server's own event stream, from its log.
    const rep = r.server.toReplay();
    const [i1, i2] = [expandInputs(rep.p1, rep.ticks), expandInputs(rep.p2, rep.ticks)];
    let s = createMatch({ matchId: rep.matchId });
    let serverHits = 0;
    for (let t = 0; t < rep.ticks; t++) {
      const n = step(s, i1[t] as number, i2[t] as number);
      serverHits += deriveEvents(s, n, RULES.heat.max).filter((e) => e.kind === "hit").length;
      s = n;
    }
    expect(serverHits).toBeGreaterThan(10);
    for (const seen of r.events!) {
      const hits = seen.filter((e) => e.kind === "hit").length;
      // Every real hit shows; mispredicted ones may add a few.
      expect(hits).toBeGreaterThanOrEqual(serverHits);
      expect(hits).toBeLessThanOrEqual(serverHits * 1.25 + 2);
      // One KO/round-end banner per real round end at most once each.
      const ends = seen.filter((e) => e.kind === "roundEnd").length;
      expect(ends).toBeLessThanOrEqual(5);
    }
  });
});
