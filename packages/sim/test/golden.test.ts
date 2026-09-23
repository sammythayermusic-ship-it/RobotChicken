import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RULES, runReplay, type Replay } from "../src/index";

const DIR = join(import.meta.dirname, "golden");
const GOLDENS = readdirSync(DIR)
  .filter((f) => f.endsWith(".replay.json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(DIR, f), "utf8")) as Replay);

describe("golden replays", () => {
  it("exist", () => {
    expect(GOLDENS.length).toBeGreaterThan(0);
  });
  for (const r of GOLDENS) {
    it(`${r.name} reproduces its committed hashes and every checkpoint`, () => {
      expect(r.rulesHash, "rules changed: run `pnpm replay:golden --bless` and say why in the commit").toBe(RULES.hash);
      const res = runReplay(r, RULES);
      expect(res.hash).toBe(r.finalHash);
      expect(res.trace).toBe(r.traceHash);
      expect(res.cps).toEqual(r.cp);
    });
  }
});
