import { describe, expect, it } from "vitest";
import contract from "../data/chicken.contract.json" with { type: "json" };
import movesJson from "../data/moves.json" with { type: "json" };
import { CLIP_NAMES, Mv, RULES, SIM_VERSION, compileRules, rulesHash, validateRules } from "../src/index";

describe("rules", () => {
  it("validates", () => {
    expect(validateRules(RULES)).toEqual([]);
  });
  it("has exactly the 21 contract clips, in order", () => {
    expect(CLIP_NAMES.length).toBe(21);
    expect(contract.clips.map((c) => c.name)).toEqual([...CLIP_NAMES]);
  });
  it("attack clips match their move frame totals (sim frame f = clip sample f)", () => {
    for (const id of [Mv.peck, Mv.shove, Mv.slam, Mv.super]) {
      const mv = RULES.moves[id]!;
      expect(RULES.clips[mv.clip]!.frames, mv.name).toBe(mv.total);
      expect(RULES.clips[mv.clip]!.phases, mv.name).toEqual([mv.startup, mv.active, mv.recovery]);
    }
  });
  it("jump arc: vy = gravity * airTicks / 2", () => {
    const f = RULES.fighter;
    expect(f.gravity * f.jumpAirTicks).toBe(2 * f.jumpVy);
  });
  it("rulesHash is stable and data-sensitive", () => {
    expect(compileRules().hash).toBe(RULES.hash);
    const R2 = compileRules();
    R2.moves[Mv.peck]!.damage += 1;
    expect(rulesHash(R2)).not.toBe(RULES.hash);
  });
});

describe("rules validation", () => {
  const moves = () => JSON.parse(JSON.stringify(movesJson)) as typeof movesJson;
  it("rejects a fractional, missing or out-of-range value instead of hashing it the same", () => {
    const a = moves();
    a.fighter.walkBack = 45.5;
    expect(() => compileRules(a)).toThrow(/walkBack/);
    const b = moves() as unknown as { moves: { slam: Record<string, unknown> } };
    delete b.moves.slam.hitstun;
    expect(() => compileRules(b as unknown as typeof movesJson)).toThrow(/slam\.hitstun/);
    const c = moves();
    c.match.round = 3600 + 2 ** 32;
    expect(() => compileRules(c)).toThrow(/match\.round/);
  });
  it("rejects a malformed pair instead of defaulting it", () => {
    const a = moves() as unknown as { moves: { peck: { onHit: { push: number[] } } } };
    a.moves.peck.onHit.push = [300];
    expect(() => compileRules(a as unknown as typeof movesJson)).toThrow(/peck\.onHit\.push/);
  });
  it("resolves each move's hit helper by hitNode and fails on an unknown one", () => {
    expect(RULES.moves[Mv.peck]!.hitNode).toBe("hit_beak");
    const a = moves() as unknown as { moves: { peck: { hitNode: string } } };
    a.moves.peck.hitNode = "hit_wing";
    expect(() => compileRules(a as unknown as typeof movesJson)).toThrow(/hit_wing/);
  });
  it("mixes the sim code version into the hash, and RULES is frozen", () => {
    expect(SIM_VERSION).toBeGreaterThan(0);
    expect(Object.isFrozen(RULES)).toBe(true);
    expect(Object.isFrozen(RULES.moves[Mv.peck])).toBe(true);
  });
});
