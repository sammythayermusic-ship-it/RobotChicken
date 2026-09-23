/**
 * sample.ts against three.js's own interpolants (what the game draws with), at
 * the instant the game must pose a clip for sim frame f: frameTime(f) =
 * Math.fround(f / 60), the float32 time exporters store for key f.
 */
import { describe, expect, it } from "vitest";
import { DiscreteInterpolant, LinearInterpolant, Quaternion, QuaternionLinearInterpolant, Vector3 } from "three";
import { frameTime, sampleAt } from "../src/assets/sample";

const FPS = 60;
/** Key times as Blender's exporter writes them: key f at float32 f / 60. */
const keyTimes = (n: number) => Float32Array.from({ length: n }, (_, f) => f / FPS);

describe("frameTime", () => {
  it("is exactly the float32 time stored for key f", () => {
    const t = keyTimes(600);
    for (let f = 0; f < 600; f++) expect(frameTime(f, FPS)).toBe(t[f]);
  });

  it("is often a hair above the float64 f / 60 (the trap for STEP)", () => {
    let above = 0;
    for (let f = 0; f < 600; f++) if (frameTime(f, FPS) > f / FPS) above++;
    expect(above).toBeGreaterThan(100);
  });
});

describe("sampleAt agrees with three.js interpolants", () => {
  const n = 47;
  const input = keyTimes(n);

  it("STEP, one key per frame: key f at frameTime(f), as three's DiscreteInterpolant (f / 60 would show key f - 1)", () => {
    // Distinct values so a one-key slip is visible.
    const values = Float32Array.from({ length: n }, (_, f) => f * 10 + 1);
    const three = new DiscreteInterpolant(input, values, 1, new Float32Array(1));
    let slipped = 0;
    for (let f = 0; f < n; f++) {
      const t = frameTime(f, FPS);
      expect(sampleAt(input, values, 1, "STEP", t, false), `frame ${f}`).toEqual([values[f]]);
      expect(three.evaluate(t)[0], `three at frame ${f}`).toBe(values[f]);
      // The bake snaps f / 60 onto key f too, but three at f / 60 shows the previous key whenever the key is stored above it.
      expect(sampleAt(input, values, 1, "STEP", f / FPS, false)).toEqual([values[f]]);
      if (three.evaluate(f / FPS)[0] !== values[f]) slipped++;
      // Between frames STEP holds the earlier key in both.
      if (f < n - 1) {
        const mid = (f + 0.5) / FPS;
        expect(sampleAt(input, values, 1, "STEP", mid, false)).toEqual([three.evaluate(mid)[0]]);
      }
    }
    expect(slipped).toBeGreaterThan(0);
  });

  it("STEP clamps outside the keys like three", () => {
    const values = Float32Array.from({ length: n }, (_, f) => f);
    const three = new DiscreteInterpolant(input, values, 1, new Float32Array(1));
    for (const t of [-1, 0, input[n - 1]!, 10]) expect(sampleAt(input, values, 1, "STEP", t, false)).toEqual([three.evaluate(t)[0]]);
  });

  it("LINEAR vec3 at frames and between them", () => {
    const values = Float32Array.from({ length: n * 3 }, (_, i) => Math.sin(i * 0.7) * 0.5);
    const three = new LinearInterpolant(input, values, 3, new Float32Array(3));
    for (let f = 0; f < n - 1; f++) {
      for (const u of [0, 0.25, 0.5, 0.75]) {
        const t = u === 0 ? frameTime(f, FPS) : (f + u) / FPS;
        const ours = sampleAt(input, values, 3, "LINEAR", t, false);
        const theirs = Array.from(three.evaluate(t));
        ours.forEach((v, j) => expect(v, `frame ${f} + ${u}`).toBeCloseTo(theirs[j]!, 6));
      }
    }
  });

  it("LINEAR rotation slerps like three's QuaternionLinearInterpolant", () => {
    const q = new Quaternion();
    const axis = new Vector3();
    const values = new Float32Array(n * 4);
    for (let f = 0; f < n; f++) {
      axis.set(Math.sin(f), 1, Math.cos(f * 1.3)).normalize();
      q.setFromAxisAngle(axis, f * 0.3 - 2);
      values.set([q.x, q.y, q.z, q.w], f * 4);
    }
    const three = new QuaternionLinearInterpolant(input, values, 4, new Float32Array(4));
    for (let f = 0; f < n - 1; f++) {
      for (const u of [0, 0.3, 0.5, 0.9]) {
        const t = u === 0 ? frameTime(f, FPS) : (f + u) / FPS;
        const ours = sampleAt(input, values, 4, "LINEAR", t, true);
        const theirs = Array.from(three.evaluate(t));
        // Either sign is the same rotation.
        const sign = ours.reduce((s, v, j) => s + v * theirs[j]!, 0) < 0 ? -1 : 1;
        ours.forEach((v, j) => expect(sign * v, `frame ${f} + ${u}`).toBeCloseTo(theirs[j]!, 5));
      }
    }
  });
});
