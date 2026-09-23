import { describe, expect, it } from "vitest";
import contract from "../data/chicken.contract.json" with { type: "json" };
import { CLIP_NAMES, Mv, RULES, compileRules, rulesHash, validateRules } from "../src/index";

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
