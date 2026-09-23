import { describe, expect, it } from "vitest";
import {
  B, CPU_LEVELS, Mv, Phase, St, createCpu, createMatch, cpuObserve, cpuThink, stateHash, step, type CpuConfig, type MatchState,
} from "../src/index";
import { fightingMatch } from "./helpers/run";

function cpuMatch(id: string, l1: CpuConfig, l2: CpuConfig): { s: MatchState; inputs: [number[], number[]] } {
  const c1 = createCpu(id, 0);
  const c2 = createCpu(id, 1);
  let s = createMatch({ matchId: id });
  const in1: number[] = [];
  const in2: number[] = [];
  while (s.phase !== Phase.matchEnd && s.tick < 40000) {
    const b1 = cpuThink(s, 0, c1, l1);
    const b2 = cpuThink(s, 1, c2, l2);
    in1.push(b1);
    in2.push(b2);
    s = step(s, b1, b2);
  }
  return { s, inputs: [in1, in2] };
}

describe("cpu", () => {
  it("is deterministic per match id", () => {
    const a = cpuMatch("cpu-det", CPU_LEVELS.normal, CPU_LEVELS.hard);
    const b = cpuMatch("cpu-det", CPU_LEVELS.normal, CPU_LEVELS.hard);
    expect(stateHash(a.s)).toBe(stateHash(b.s));
    expect(a.inputs).toEqual(b.inputs);
  });

  it("CPU vs CPU always finishes, and every move gets used", () => {
    const used = new Set<number>();
    for (let seed = 0; seed < 12; seed++) {
      const id = `cpu-finish-${seed}`;
      const c1 = createCpu(id, 0);
      const c2 = createCpu(id, 1);
      let s = createMatch({ matchId: id });
      while (s.phase !== Phase.matchEnd && s.tick < 40000) {
        s = step(s, cpuThink(s, 0, c1, CPU_LEVELS.hard), cpuThink(s, 1, c2, CPU_LEVELS.easy));
        for (const f of s.f) if (f.st === St.attack) used.add(f.move);
      }
      expect(s.phase).toBe(Phase.matchEnd);
    }
    for (const m of [Mv.peck, Mv.shove, Mv.slam, Mv.dive_kick, Mv.super]) expect(used.has(m), `move ${m} used`).toBe(true);
  });

  it("harder CPUs beat easier ones", () => {
    let hardWins = 0;
    for (let seed = 0; seed < 20; seed++) {
      const swap = seed % 2 === 1;
      const { s } = cpuMatch(`cpu-strength-${seed}`, swap ? CPU_LEVELS.easy : CPU_LEVELS.hard, swap ? CPU_LEVELS.hard : CPU_LEVELS.easy);
      if (s.matchWinner === (swap ? 1 : 0)) hardWins++;
    }
    expect(hardWins).toBeGreaterThanOrEqual(14);
  });

  it("sees the opponent exactly `delay` ticks late", () => {
    for (const level of [CPU_LEVELS.easy, CPU_LEVELS.normal, CPU_LEVELS.hard]) {
      const mem = createCpu("cpu-view", 1);
      let s = fightingMatch("cpu-view");
      const xs = new Map<number, number>();
      for (let t = 0; t < 80; t++) {
        const seen = cpuObserve(mem, s, 1, level.delay);
        xs.set(s.tick, s.f[0].x);
        const expectTick = s.tick - level.delay;
        if (xs.has(expectTick)) expect(seen.x).toBe(xs.get(expectTick));
        s = step(s, B.R, 0);
      }
    }
  });
});
