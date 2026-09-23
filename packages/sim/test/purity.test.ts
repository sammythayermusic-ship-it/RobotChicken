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
