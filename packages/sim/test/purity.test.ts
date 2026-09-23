import { describe, expect, it } from "vitest";
import { B, createMatch, stateHash, step } from "../src/index";
import { deepFreeze } from "./helpers/freeze";

describe("step purity", () => {
  it("never mutates prev and shares no objects with it", () => {
    let s = createMatch({ matchId: "pure" });
    for (let i = 0; i < 400; i++) {
      const before = stateHash(s);
      const frozen = deepFreeze(s);
      const next = step(frozen, i % 7 === 0 ? B.R : B.L, B.S, undefined);
      expect(stateHash(frozen)).toBe(before);
      expect(next).not.toBe(frozen);
      expect(next.f[0]).not.toBe(frozen.f[0]);
      expect(next.f[1]).not.toBe(frozen.f[1]);
      s = next;
    }
  });
  it("is deterministic", () => {
    const run = () => {
      let s = createMatch({ matchId: "det" });
      for (let i = 0; i < 1000; i++) s = step(s, (i * 7) & 31, (i * 13) & 31);
      return stateHash(s);
    };
    expect(run()).toBe(run());
  });
});

describe("replay validation", () => {
  it("rejects unsorted events, bad buttons, a zero hold and a wrong version", async () => {
    const { runReplay, RULES } = await import("../src/index");
    const base = { v: 1 as const, rulesHash: RULES.hash, matchId: "x", ticks: 10, finalHash: "" };
    expect(() => runReplay({ ...base, p1: [{ t: 5, b: 1 }, { t: 3, b: 2 }] })).toThrow(/increasing/);
    expect(() => runReplay({ ...base, p1: [{ t: 1, b: 64 }] })).toThrow(/buttons/);
    expect(() => runReplay({ ...base, gen: { kind: "xorshift", seed: 1, hold: [0, 3] } })).toThrow(/hold/);
    expect(() => runReplay({ ...base, v: 2 as unknown as 1 })).toThrow(/version/);
    expect(() => runReplay({ ...base, ticks: 0 })).toThrow(/ticks/);
  });
});
