import { describe, expect, it } from "vitest";
import { Phase, runReplay, stateHash } from "@cockfight/sim";
import { LocalMatch } from "./LocalMatch";
import { CpuSource } from "./input/source";

describe("LocalMatch", () => {
  it("plays a CPU match to the end and its input log replays to the same hash", () => {
    const m = new LocalMatch("local-test", [new CpuSource("local-test", 0, "hard"), new CpuSource("local-test", 1, "normal")]);
    const kinds = new Set<string>();
    while (m.cur.phase !== Phase.matchEnd && m.cur.tick < 40000) for (const e of m.tick()) kinds.add(e.kind);
    expect(m.cur.phase).toBe(Phase.matchEnd);
    for (const k of ["countdown", "fight", "attack", "hit", "roundEnd", "matchEnd"]) expect(kinds.has(k), k).toBe(true);
    const r = m.toReplay();
    expect(runReplay(r).hash).toBe(stateHash(m.cur));
  });
});
