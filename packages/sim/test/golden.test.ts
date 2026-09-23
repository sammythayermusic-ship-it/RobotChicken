import { describe, expect, it } from "vitest";
import walkTimeout from "./golden/walk-timeout.replay.json" with { type: "json" };
import random3 from "./golden/random-3rounds.replay.json" with { type: "json" };
import everyMove from "./golden/every-move.replay.json" with { type: "json" };
import cpu1 from "./golden/cpu-seed1.replay.json" with { type: "json" };
import cpu2 from "./golden/cpu-seed2.replay.json" with { type: "json" };
import cpu3 from "./golden/cpu-seed3.replay.json" with { type: "json" };
import cpu4 from "./golden/cpu-seed4.replay.json" with { type: "json" };
import cpu5 from "./golden/cpu-seed5.replay.json" with { type: "json" };
import { RULES, runReplay, type Replay } from "../src/index";

const GOLDENS = [walkTimeout, random3, everyMove, cpu1, cpu2, cpu3, cpu4, cpu5] as unknown as Replay[];

describe("golden replays", () => {
  for (const r of GOLDENS) {
    it(`${r.name} reproduces its committed hash and checkpoints`, () => {
      expect(r.rulesHash, "rules changed: run `pnpm replay:golden --bless` and say why in the commit").toBe(RULES.hash);
      const res = runReplay(r, RULES);
      expect(res.hash).toBe(r.finalHash);
      expect(res.cps).toEqual(r.cp);
    });
  }
});
