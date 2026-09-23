import { Group } from "three";
import { describe, expect, it } from "vitest";
import { HitKind, RULES, St, newFighter, type FighterState } from "@cockfight/sim";
import { ChickenView } from "./ChickenView";

const asset = () => ({ scene: new Group(), animations: [] });
const RIGHT = Math.PI / 2;
const LEFT = -Math.PI / 2;

function fighter(side: 0 | 1, patch: Partial<FighterState> = {}): FighterState {
  return { ...newFighter(side), ...patch };
}

describe("ChickenView", () => {
  it("shows P2 facing left from the first frame, with no turn at the start of a match", () => {
    const p2 = fighter(1);
    expect(p2.facing).toBe(-1);
    // Rendered before any tick (manual mode, the loading frame)...
    const a = new ChickenView(asset(), "rust");
    a.render(p2, p2, 1, 0);
    expect(a.root.rotation.y).toBeCloseTo(LEFT);
    // ...or ticked first (the live loop): either way it never passes through the camera-facing pose.
    const b = new ChickenView(asset(), "rust");
    for (let t = 1; t <= 6; t++) {
      b.tick(p2);
      b.render(p2, p2, 1, t);
      expect(b.root.rotation.y).toBeCloseTo(LEFT);
    }
  });

  it("still turns when the fighter changes sides later", () => {
    const v = new ChickenView(asset(), "rust");
    const p1 = fighter(0);
    v.tick(p1);
    v.render(p1, p1, 1, 1);
    expect(v.root.rotation.y).toBeCloseTo(RIGHT);
    const crossed = { ...p1, facing: -1 };
    v.tick(crossed);
    v.tick(crossed);
    v.render(crossed, crossed, 1, 3);
    // Part way through the turn, then settled.
    expect(v.root.rotation.y).toBeLessThan(RIGHT);
    expect(v.root.rotation.y).toBeGreaterThan(LEFT);
    for (let t = 3; t < 12; t++) v.tick(crossed);
    v.render(crossed, crossed, 1, 12);
    expect(v.root.rotation.y).toBeCloseTo(LEFT);
  });

  it("shakes the fighter that was just hit, not an attacker frozen by its own dive kick", () => {
    const diveKick = RULES.moves.find((m) => m.name === "dive_kick");
    expect(diveKick?.hitstop).toBeGreaterThan(0);
    const tick = 600;
    // P1 was hit 300 ticks ago, then lands a dive kick: it bounces into `fall` and shares the hit-stop.
    const attacker = fighter(0, { st: St.fall, hitstop: diveKick?.hitstop ?? 3, hitKind: HitKind.hit, hitT: tick - 300, x: 0 });
    const victim = fighter(1, { st: St.hitStun, hitstop: diveKick?.hitstop ?? 3, hitKind: HitKind.hit, hitT: tick, x: 0 });
    const xs = (f: FighterState) => {
      const v = new ChickenView(asset(), "rust");
      v.tick(f);
      const out: number[] = [];
      for (let t = tick; t < tick + 4; t++) {
        v.render(f, f, 1, t);
        out.push(v.root.position.x);
      }
      return out;
    };
    expect(new Set(xs(attacker)).size).toBe(1);
    expect(new Set(xs(victim)).size).toBe(2);
  });
});
