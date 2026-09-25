import { describe, expect, it } from "vitest";
import { MIN_CHANGES, analyzeTiming, repeatPeriod } from "../src/botcheck";

/** Masks for a sequence of (holdTicks, mask) pairs. */
const play = (steps: [number, number][]): number[] => steps.flatMap(([n, m]) => Array<number>(n).fill(m));

/** A deterministic jittered human: holds of 8-30 ticks. */
function human(changes: number, seed = 1): number[] {
  let x = seed;
  const rnd = () => ((x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const steps: [number, number][] = [];
  for (let i = 0; i < changes; i++) steps.push([8 + Math.floor(rnd() * 22), (i % 3) + 1]);
  return play(steps);
}

describe("input-timing analysis", () => {
  it("says nothing about a short match or a jittery human", () => {
    expect(analyzeTiming(play([[10, 1], [10, 0], [10, 1]])).flag).toBeNull();
    const r = analyzeTiming(human(200));
    expect(r.changes).toBeGreaterThanOrEqual(MIN_CHANGES);
    expect(r.cv).toBeGreaterThan(0.2);
    expect(r.flag).toBeNull();
  });

  it("flags metronome-regular button changes", () => {
    const steps: [number, number][] = [];
    for (let i = 0; i < 80; i++) steps.push([12, (i % 2) + 1]);
    const r = analyzeTiming(play(steps));
    expect(r.cv).toBeLessThan(0.01);
    expect(r.flag).toBe("timing");
  });

  it("flags a fixed macro replayed many times, even with an irregular rhythm inside it", () => {
    const macro: [number, number][] = [[7, 1], [13, 2], [9, 0], [22, 3], [11, 2], [15, 0]];
    const steps: [number, number][] = [];
    for (let i = 0; i < 20; i++) steps.push(...macro);
    const r = analyzeTiming(play(steps));
    expect(r.cv).toBeGreaterThan(0.3);
    expect(r.period).toBe(6);
    expect(r.flag).toBe("macro");
  });

  it("finds the shortest repeat period, and none for a sequence that only mostly repeats", () => {
    expect(repeatPeriod(["a", "b", "a", "b", "a", "b", "a", "b"])).toBe(2);
    expect(repeatPeriod(["a", "b", "c", "a", "b", "c", "a", "b", "c", "a", "b", "c", "a"])).toBe(3);
    expect(repeatPeriod(["a", "b", "a", "b", "a", "b", "a", "c"])).toBe(0);
    expect(repeatPeriod(["a", "b"])).toBe(0);
  });
});
