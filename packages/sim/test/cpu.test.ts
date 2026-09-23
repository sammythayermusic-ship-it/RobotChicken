import { describe, expect, it } from "vitest";
import {
  B, CPU_LEVELS, HitKind, Mv, Phase, Rng, St, createCpu, createMatch, cpuObserve, cpuThink, seedFromId, stateHash, step, type CpuConfig, type MatchState,
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

  it("harder CPUs beat easier ones: easy < normal < hard", () => {
    const wins = (strong: CpuConfig, weak: CpuConfig, tag: string) => {
      let n = 0;
      for (let seed = 0; seed < 20; seed++) {
        const swap = seed % 2 === 1;
        const { s } = cpuMatch(`cpu-strength-${tag}-${seed}`, swap ? weak : strong, swap ? strong : weak);
        if (s.matchWinner === (swap ? 1 : 0)) n++;
      }
      return n;
    };
    expect(wins(CPU_LEVELS.hard, CPU_LEVELS.easy, "he")).toBeGreaterThanOrEqual(16);
    expect(wins(CPU_LEVELS.normal, CPU_LEVELS.easy, "ne")).toBeGreaterThanOrEqual(14);
    expect(wins(CPU_LEVELS.hard, CPU_LEVELS.normal, "hn")).toBeGreaterThanOrEqual(14);
  });

  it("walk-and-peck is not a free win, and the levels are ordered against it", () => {
    // The review's script: walk in to 1.4 units, then press Space every N ticks. Before the fix
    // it won every match against every level, and Easy blocked the most.
    const walkPeck = (level: CpuConfig, period: number, id: string) => {
      const cpu = createCpu(id, 1);
      let s = createMatch({ matchId: id });
      let t = 0;
      let taken = 0;
      let rounds = 0;
      while (s.phase !== Phase.matchEnd && s.tick < 40000) {
        let b1 = 0;
        if (s.phase === Phase.fighting) {
          if (s.f[1].x - s.f[0].x > 1400) b1 = B.R;
          else if (++t % period === 0) b1 = B.S;
        }
        const prev = s;
        s = step(s, b1, cpuThink(s, 1, cpu, level));
        if (s.f[1].hitT === s.tick && s.f[1].hitKind === HitKind.hit) taken++;
        if (prev.phase === Phase.fighting && s.phase !== Phase.fighting) rounds++;
      }
      return { cpuWon: s.matchWinner === 1, taken, rounds };
    };
    const levels = ["easy", "normal", "hard"] as const;
    const wins = { easy: 0, normal: 0, hard: 0 };
    const taken = { easy: 0, normal: 0, hard: 0 };
    const rounds = { easy: 0, normal: 0, hard: 0 };
    for (const period of [8, 12, 20]) {
      let hardWins = 0;
      for (let m = 0; m < 10; m++) {
        for (const lvl of levels) {
          const r = walkPeck(CPU_LEVELS[lvl], period, `walk-peck-${period}-${m}`);
          if (r.cpuWon) wins[lvl]++;
          if (lvl === "hard" && r.cpuWon) hardWins++;
          taken[lvl] += r.taken;
          rounds[lvl] += r.rounds;
        }
      }
      expect(hardWins, `Hard vs walk-and-peck every ${period} ticks`).toBeGreaterThanOrEqual(8);
    }
    // Every level takes matches off it (Easy too), and a harder level takes more.
    expect(wins.easy).toBeGreaterThanOrEqual(6);
    expect(wins.normal).toBeGreaterThan(wins.easy);
    expect(wins.hard).toBeGreaterThan(wins.normal);
    // Clean hits taken per round: Hard lets far fewer through than Easy. (Hard blocks a smaller
    // share of the pecks than Easy does: it pecks the walker first instead of waiting to block.)
    expect(taken.hard / rounds.hard).toBeLessThan((taken.easy / rounds.easy) * 0.85);
  });

  it("Hard shuts down button mashing and dive-kick spam; a masher beats Easy", () => {
    // Small versions of the tuning harness (docs/decisions.md has the full numbers).
    const play = (p1: (s: MatchState) => number, level: CpuConfig, id: string) => {
      const cpu = createCpu(id, 1);
      let s = createMatch({ matchId: id });
      while (s.phase !== Phase.matchEnd && s.tick < 40000) s = step(s, p1(s), cpuThink(s, 1, cpu, level));
      return s.matchWinner === 0;
    };
    // Mashing random buttons.
    const masher = (id: string) => {
      const rng = new Rng(seedFromId(`${id}:mash`));
      let b = 0;
      let left = 0;
      return (s: MatchState) => {
        if (s.phase !== Phase.fighting) return 0;
        if (left <= 0) {
          b = rng.int(32);
          left = 1 + rng.int(20);
        }
        left--;
        return b;
      };
    };
    // Walk in, jump forward and dive kick, over and over.
    const diver = () => (s: MatchState) => {
      if (s.phase !== Phase.fighting) return 0;
      const me = s.f[0];
      const gap = Math.abs(s.f[1].x - me.x);
      const fwd = me.facing > 0 ? B.R : B.L;
      if (me.st === St.jump) return s.tick & 1 ? B.S : 0;
      if (me.st !== St.idle && me.st !== St.walkF && me.st !== St.walkB) return 0;
      if (gap > 2100) return fwd;
      if (gap < 1500) return fwd === B.R ? B.L : B.R;
      return B.U | fwd;
    };
    let mashVsHard = 0;
    let mashVsEasy = 0;
    let diveVsHard = 0;
    for (let m = 0; m < 10; m++) {
      if (play(masher(`mash-h-${m}`), CPU_LEVELS.hard, `mash-h-${m}`)) mashVsHard++;
      if (play(masher(`mash-e-${m}`), CPU_LEVELS.easy, `mash-e-${m}`)) mashVsEasy++;
      if (play(diver(), CPU_LEVELS.hard, `dive-h-${m}`)) diveVsHard++;
    }
    expect(mashVsHard, "a masher vs Hard").toBeLessThanOrEqual(2);
    expect(diveVsHard, "dive-kick spam vs Hard").toBeLessThanOrEqual(2);
    expect(mashVsEasy, "a masher vs Easy").toBeGreaterThanOrEqual(7);
  });

  it("dodges a dive kick it sees coming, Hard far more often than Easy", () => {
    const dodged = (level: CpuConfig) => {
      let n = 0;
      for (const gap of [1700, 2100, 2500]) {
        for (let seed = 0; seed < 10; seed++) {
          const id = `cpu-dive-${gap}-${seed}`;
          const mem = createCpu(id, 1);
          let s = fightingMatch(id);
          // Let the CPU settle (its eyes fill) at the gap before the jump.
          for (let i = 0; i < 30; i++) {
            s.f[0].x = -(gap >> 1);
            s.f[1].x = gap - (gap >> 1);
            s = step(s, 0, cpuThink(s, 1, mem, level));
          }
          s.f[0].x = -(gap >> 1);
          s.f[1].x = gap - (gap >> 1);
          let hit = false;
          for (let t = 0; t < 70 && !hit; t++) {
            const b1 = t === 0 ? B.U | B.R : t === 1 ? B.S : 0; // the press waits for the dive gate
            s = step(s, b1, cpuThink(s, 1, mem, level));
            hit = s.f[1].hitT === s.tick && s.f[1].hitMv === Mv.dive_kick && s.f[1].hitKind === HitKind.hit;
          }
          if (!hit) n++;
        }
      }
      return n;
    };
    const hard = dodged(CPU_LEVELS.hard);
    expect(hard).toBeGreaterThanOrEqual(21); // of 30
    expect(hard).toBeGreaterThan(dodged(CPU_LEVELS.easy) + 5);
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
