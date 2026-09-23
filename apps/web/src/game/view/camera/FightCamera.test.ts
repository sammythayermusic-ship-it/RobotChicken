import { describe, expect, it } from "vitest";
import { FightCamera } from "./FightCamera";

describe("FightCamera", () => {
  it("keeps both fighters in frame at any aspect", () => {
    for (const aspect of [16 / 9, 4 / 3, 21 / 9, 1.2]) {
      const w = FightCamera.wantWidth(-6, 6);
      const d = FightCamera.distanceFor(w, aspect);
      const hfov = 2 * Math.atan(Math.tan((30 * Math.PI) / 360) * aspect);
      expect(2 * d * Math.tan(hfov / 2)).toBeCloseTo(w, 5);
      expect(w).toBeGreaterThanOrEqual(12);
    }
  });
  it("clamps the framed width between 10 and 20 units", () => {
    expect(FightCamera.wantWidth(0, 0)).toBe(10);
    expect(FightCamera.wantWidth(-10, 10)).toBe(20);
  });
  it("shake is deterministic for a seed and decays to zero", () => {
    const a = new FightCamera(16 / 9, 42);
    const b = new FightCamera(16 / 9, 42);
    a.addTrauma(1);
    b.addTrauma(1);
    for (let i = 0; i < 20; i++) {
      a.tick(-2, 2);
      b.tick(-2, 2);
      expect(a.shakeOffsets()).toEqual(b.shakeOffsets());
    }
    for (let i = 0; i < 120; i++) a.tick(-2, 2);
    expect(a.traumaLevel).toBe(0);
  });
  it("reduced shake scales offsets", () => {
    const a = new FightCamera(16 / 9, 7);
    const b = new FightCamera(16 / 9, 7);
    b.shake.amount = 0.3;
    a.addTrauma(1);
    b.addTrauma(1);
    a.tick(0, 3);
    b.tick(0, 3);
    expect(Math.abs(b.shakeOffsets().y)).toBeLessThanOrEqual(Math.abs(a.shakeOffsets().y));
  });
});
