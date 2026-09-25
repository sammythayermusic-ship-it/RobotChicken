import { describe, expect, it } from "vitest";
import { Mv, SIM_EVENT_KINDS, type SimEvent } from "@cockfight/sim";
import { SOUND_NAMES, SOUND_SPECS } from "../audio/names";
import { FX_TABLE, hitRecipe, recipeFor, screamFor } from "./fxTable";

describe("fxTable", () => {
  it("covers every sim event kind", () => {
    for (const k of SIM_EVENT_KINDS) {
      if (k === "hit") continue;
      expect(FX_TABLE[k as keyof typeof FX_TABLE], k).toBeTypeOf("function");
    }
  });
  it("only references known sounds", () => {
    const hit: SimEvent = { kind: "hit", side: 1, by: 0, move: Mv.peck, blocked: false, damage: 600, x: 0, y: 800 };
    const all: SimEvent[] = [hit, { ...hit, blocked: true }, { ...hit, move: Mv.super, damage: 3000 }];
    for (const k of SIM_EVENT_KINDS) if (k !== "hit") all.push({ kind: k } as SimEvent);
    for (const e of all) for (const s of recipeFor(e, 10000).sounds) expect(SOUND_NAMES).toContain(s);
  });
  it("every sound has a spec", () => {
    for (const n of SOUND_NAMES) expect(SOUND_SPECS[n]).toBeDefined();
  });
  it("scream tiers by damage", () => {
    expect(screamFor(6, Mv.peck)).toBe("scream_light");
    expect(screamFor(10, Mv.dive_kick)).toBe("scream_medium");
    expect(screamFor(18, Mv.slam)).toBe("scream_heavy");
  });
  it("heavy hits shake harder than light ones", () => {
    const light = hitRecipe({ kind: "hit", side: 1, by: 0, move: Mv.peck, blocked: false, damage: 600, x: 0, y: 0 }, 10000);
    const heavy = hitRecipe({ kind: "hit", side: 1, by: 0, move: Mv.slam, blocked: false, damage: 1800, x: 0, y: 0 }, 10000);
    expect(heavy.trauma).toBeGreaterThan(light.trauma);
    expect(heavy.bursts[0]!.count).toBeGreaterThan(light.bursts[0]!.count);
  });
});
