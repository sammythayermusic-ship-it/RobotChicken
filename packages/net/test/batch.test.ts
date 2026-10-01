import { describe, expect, it } from "vitest";
import { FRAMES_EVERY, FrameBatcher } from "../src/batch";
import { SYNC_EVERY, decodeFrames } from "../src/protocol";
import { simulate } from "./harness";

describe("FrameBatcher", () => {
  it("sends every FRAMES_EVERY ticks and always on a sync tick", () => {
    expect(SYNC_EVERY % FRAMES_EVERY).toBe(0);
    const b = new FrameBatcher(2);
    expect(b.push({ tick: 1, b1: 1, b2: 2 })).toBe(false);
    expect(b.push({ tick: 2, b1: 3, b2: 4 })).toBe(true);
    const f = decodeFrames(b.encode(5))!;
    expect(f).toEqual({ first: 1, b1: [1, 3], b2: [2, 4], margin: 5 });
    b.clear();
    expect(b.pending).toBe(false);
    expect(() => new FrameBatcher(7)).toThrow();
  });

  it("batched frames keep the netcode's guarantees (80 ms RTT, both rates)", () => {
    for (const framesEvery of [1, 2]) {
      const r = simulate({ rttMs: 80, jitterMs: 8, seconds: 60, hz: [60, 59.9], bots: ["hard", "mash"], seed: 11, framesEvery });
      expect(r.converged).toEqual([true, true]);
      for (const c of r.clients) {
        expect(c.stats.desyncs).toBe(0);
        expect(c.stats.corrections.filter((x) => x.snapped).length).toBe(0);
        expect(c.stats.maxDepth).toBeLessThanOrEqual(10);
      }
    }
  });
});
