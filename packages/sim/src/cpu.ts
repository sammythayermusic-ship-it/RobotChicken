/**
 * A simple, deterministic CPU opponent. It lives outside step(): it reads the
 * state and returns a button mask, so a CPU match replays from its input log
 * alone. Difficulty = how stale its view of the opponent is (reaction delay)
 * and how often it blocks / punishes. Its own RNG is seeded from the match id.
 */
import { holdsFwd } from "./input";
import { Rng, seedFromId } from "./rng";
import type { MoveRules, Rules } from "./rules";
import { RULES } from "./rules";
import { B, Mv, Phase, St, type FighterState, type MatchState } from "./types";

export interface CpuConfig {
  /** Ticks between an opponent action and the CPU seeing it. */
  delay: number;
  /** % chance to block an attack it sees starting. */
  blockPct: number;
  /** % chance to punish a whiff it sees. */
  punishPct: number;
  /** % chance to start an attack when in range and nothing better to do. */
  aggression: number;
  /** Ticks between neutral decisions. */
  think: number;
}

export const CPU_LEVELS = {
  easy: { delay: 22, blockPct: 30, punishPct: 30, aggression: 25, think: 14 },
  normal: { delay: 14, blockPct: 60, punishPct: 60, aggression: 45, think: 9 },
  hard: { delay: 8, blockPct: 85, punishPct: 90, aggression: 60, think: 5 },
} as const satisfies Record<string, CpuConfig>;
export type CpuLevel = keyof typeof CPU_LEVELS;

const HISTORY = 64;

export interface CpuMemory {
  rng: Rng;
  /** Ring buffer of observed opponent snapshots, indexed by tick. */
  seen: (FighterState | null)[];
  /** Queued masks to emit on the next ticks (press sequences). */
  plan: number[];
  /** Mask held when the plan is empty. */
  hold: number;
  holdLeft: number;
  nextThink: number;
}

export function createCpu(matchId: string, side: 0 | 1): CpuMemory {
  return {
    rng: new Rng(seedFromId(`${matchId}:cpu:${side}`)),
    seen: new Array<FighterState | null>(HISTORY).fill(null),
    plan: [],
    hold: 0,
    holdLeft: 0,
    nextThink: 0,
  };
}

/** Record the opponent this tick and return what the CPU "sees": the opponent `delay` ticks ago. */
export function cpuObserve(mem: CpuMemory, s: MatchState, side: 0 | 1, delay: number): FighterState {
  const opp = s.f[1 - side] as FighterState;
  mem.seen[s.tick % HISTORY] = { ...opp };
  const k = s.tick - delay;
  const old = k >= 0 ? mem.seen[k % HISTORY] : null;
  return old ?? opp;
}

function attackPhase(f: FighterState, R: Rules): "startup" | "active" | "recovery" | null {
  if (f.st !== St.attack) return null;
  const mv = R.moves[f.move] as MoveRules;
  if (f.stTick <= mv.startup) return "startup";
  if (f.stTick <= mv.startup + mv.active) return "active";
  return "recovery";
}

/** Decide this tick's buttons for the CPU playing `side`. Call once per tick, before step(). */
export function cpuThink(s: MatchState, side: 0 | 1, mem: CpuMemory, cfg: CpuConfig, R: Rules = RULES): number {
  const me = s.f[side] as FighterState;
  const opp = cpuObserve(mem, s, side, cfg.delay);
  if (s.phase !== Phase.fighting) {
    mem.plan.length = 0;
    mem.hold = 0;
    return 0;
  }
  if (mem.plan.length > 0) return mem.plan.shift() as number;
  if (mem.holdLeft > 0) {
    mem.holdLeft -= 1;
    return mem.hold;
  }

  const fwd = me.facing > 0 ? B.R : B.L;
  const back = me.facing > 0 ? B.L : B.R;
  const dist = Math.abs(opp.x - me.x);
  const rng = mem.rng;
  const heatFull = me.heat >= R.heat.max;

  // Airborne: dive when high enough and the target is below and ahead.
  if (me.st === St.jump && !me.diveUsed && me.y >= 900 && me.stTick >= 4 && dist < 3500 && rng.chance(cfg.aggression)) {
    return B.S | (holdsFwd(me) ? fwd : 0);
  }
  if (me.grounded === 0 || (me.st !== St.idle && me.st !== St.walkF && me.st !== St.walkB && me.st !== St.block)) {
    // Busy: keep blocking if already blocking, otherwise let go (so the next press is an edge).
    return me.st === St.blockStun ? B.D : 0;
  }

  const oppPhase = attackPhase(opp, R);
  const oppMove = opp.st === St.attack ? opp.move : Mv.none;

  // 1. React to what it saw.
  if (oppPhase === "startup" && dist < 2200) {
    if (oppMove === Mv.slam) {
      // Slam is unblockable: jump over it or peck it out of its long startup.
      if (rng.chance(cfg.blockPct)) return rng.chance(50) ? B.U : press(mem, B.S);
    } else if (oppMove !== Mv.dive_kick && rng.chance(cfg.blockPct)) {
      return holdFor(mem, B.D, 10 + rng.int(8));
    }
  }
  if ((oppPhase === "recovery" || opp.st === St.land || opp.st === St.getup) && dist < 1500 && rng.chance(cfg.punishPct)) {
    if (heatFull) return press(mem, B.S);
    return press(mem, rng.chance(50) ? B.D | B.S : B.S);
  }
  if (heatFull && (opp.st === St.hitStun || oppPhase === "recovery") && rng.chance(cfg.punishPct)) {
    return press(mem, B.S);
  }

  // 2. Neutral, re-evaluated every `think` ticks.
  if (s.tick < mem.nextThink) return me.st === St.walkF ? fwd : me.st === St.walkB ? back : me.st === St.block ? B.D : 0;
  mem.nextThink = s.tick + cfg.think + rng.int(cfg.think);

  const oppNearWall = Math.abs(opp.x) > 7000 && Math.abs(opp.x) > Math.abs(me.x);
  if (dist > 1350) {
    const r = rng.int(100);
    if (r < 12) {
      mem.plan.push(fwd, 0, fwd);
      return mem.plan.shift() as number;
    }
    if (r < 20 && dist < 4500) return holdFor(mem, B.U | fwd, 2);
    if (r < 28) return holdFor(mem, back, 6 + rng.int(10));
    return holdFor(mem, fwd, 8 + rng.int(12));
  }
  if (!rng.chance(cfg.aggression)) {
    const r = rng.int(100);
    if (r < 45) return holdFor(mem, B.D, 8 + rng.int(12));
    if (r < 70) return holdFor(mem, back, 6 + rng.int(8));
    if (r < 85) return holdFor(mem, B.U | back, 2);
    return 0;
  }
  if (heatFull && rng.chance(40)) return press(mem, B.S);
  if (oppNearWall && rng.chance(50)) return press(mem, fwd | B.S);
  const r = rng.int(100);
  if (r < 50) return press(mem, B.S);
  if (r < 70) return press(mem, fwd | B.S);
  if (r < 85) return press(mem, B.D | B.S);
  return holdFor(mem, B.U | fwd, 2);
}

/** Press a button combination for one tick, then release (a clean edge). */
function press(mem: CpuMemory, mask: number): number {
  mem.plan.push(0);
  return mask;
}

function holdFor(mem: CpuMemory, mask: number, ticks: number): number {
  mem.hold = mask;
  mem.holdLeft = ticks - 1;
  return mask;
}
