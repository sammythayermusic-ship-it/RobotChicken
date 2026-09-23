/**
 * A simple, deterministic CPU opponent. It lives outside step(): it reads the
 * state and returns a button mask, so a CPU match replays from its input log
 * alone. Its own RNG is seeded from the match id.
 *
 * It sees the opponent `delay` ticks late (its reaction time) and judges each
 * thing it sees once: an attack starting (guard it, jump or peck a slam), a
 * jump or a dive kick coming at it (dash under it or jump away: a peck cannot
 * beat a dive kick), an opponent walking into its reach or whiffing within it
 * (peck, slam or super them). Reactions come first and override what it was
 * doing. It knows its own state at once, so it comes out of hit stun, block
 * stun and get-up on its first free tick with a plan made as they start: keep
 * guarding, hit back first (a blocked peck leaves it ahead), super, or dash.
 * Between reactions it plays footsies every `think` ticks: walks in only to
 * the edge of its reach and holds its ground against an opponent coming at
 * it, guards some of its time in range (much more against an opponent who
 * keeps attacking there), pokes, slams opponents who keep blocking, and jumps
 * in more often when its jump-ins keep landing. Difficulty is the reaction
 * time and the odds of each choice.
 */
import { idiv, mulDiv } from "./fixed";
import { Rng, seedFromId } from "./rng";
import type { MoveRules, Rules } from "./rules";
import { RULES } from "./rules";
import { B, HitKind, Mv, Phase, St, type FighterState, type MatchState } from "./types";

export interface CpuConfig {
  /** Ticks between an opponent action and the CPU seeing it (its reaction time). */
  delay: number;
  /** % chance to guard a blockable attack it sees starting (or answer a slam); also drives how much it guards in range. */
  blockPct: number;
  /** % chance to punish a whiff or a landing it sees (only when it can still get there). */
  punishPct: number;
  /** % chance to attack when a neutral decision comes up in range. */
  aggression: number;
  /** Ticks between neutral decisions. */
  think: number;
  /** % chance to answer a jump or dive kick it sees coming at it. */
  antiAirPct: number;
  /** % chance to poke an opponent walking into its reach, to give ground back after an exchange, and to hit back out of block stun. */
  footsies: number;
}

/**
 * Reaction time and block rate are the plan's (docs/plan.md 1.2); the other odds are tuned
 * with scripted opponents (docs/decisions.md). Hard is the most patient: it pokes and
 * attacks less often than Normal, but sees everything 8 ticks late.
 */
export const CPU_LEVELS = {
  easy: { delay: 22, blockPct: 30, punishPct: 30, aggression: 30, think: 14, antiAirPct: 40, footsies: 20 },
  normal: { delay: 14, blockPct: 60, punishPct: 80, aggression: 50, think: 9, antiAirPct: 95, footsies: 75 },
  hard: { delay: 8, blockPct: 85, punishPct: 80, aggression: 40, think: 5, antiAirPct: 95, footsies: 50 },
} as const satisfies Record<string, CpuConfig>;
export type CpuLevel = keyof typeof CPU_LEVELS;

const HISTORY = 64;

/** Distances (mu) the CPU plays around: peck reach is ~1.47 u, shove ~1.31 u, slam ~1.34 u. */
const PECK_REACH = 1450;
const SLAM_RANGE = 1250;
const CLOSE = 1550;
const THREAT = 1900;
const JUMP_IN_MIN = 1800;
const JUMP_IN_MAX = 2600;
/** How far outside its peck reach a walk-in stops, and how far away an approaching opponent makes it hold its ground. */
const WALK_STOP = PECK_REACH + 300;
const HOLD_GROUND = 3400;
/** Ticks without a clean hit after which it stops waiting and presses (and when behind late in the round). */
const QUIET = 120;
const LATE = 20 * 60;

/** How the CPU comes out of a hit stun, block stun or get-up. */
const Wake = { none: 0, guard: 1, poke: 2, super: 3, dash: 4 } as const;

export interface CpuMemory {
  rng: Rng;
  /** Ring buffer of observed opponent snapshots, indexed by tick. */
  seen: (FighterState | null)[];
  /** Queued masks to emit on the next ticks (press sequences). */
  plan: number[];
  /** Mask held while holdLeft > 0. */
  hold: number;
  holdLeft: number;
  nextThink: number;
  /** The observed opponent action judged last (state, move, frame): each one is judged once. */
  evSt: number;
  evMove: number;
  evTick: number;
  /** Dive decision for its own current jump: 0 undecided, 1 dive, 2 no dive. */
  diveRoll: number;
  /** Peck -> super cancel decision for the current attack: 0 undecided, 1 cancel, 2 no. */
  cancelRoll: number;
  /** How it comes out of the current hit stun, block stun or get-up (Wake), decided once as it starts. */
  wake: number;
  /** The CPU's own state last tick (to notice entering and leaving stun). */
  lastSt: number;
  /** Opponent habits seen in range: ticks spent blocking vs otherwise (decaying). */
  oppGuard: number;
  oppOpen: number;
  /** Attacks the opponent started in range (decaying with the two counters above). */
  oppPokes: number;
  /** Its own dive kicks: started / landed clean (decaying). */
  diveTries: number;
  diveHits: number;
  /** Poking the current approach, and its speed. */
  approach: boolean;
  approachSpeed: number;
  /** A pending poke (tick, -1 = none) and its kind (0 = out of block stun, 1 = at an approach); how each kind has gone (-3..3). */
  pokeAt: number;
  pokeKind: number;
  pokeScore: [number, number];
  /** Tick of the last clean hit on either fighter (or the round start). */
  lastHit: number;
}

export function createCpu(matchId: string, side: 0 | 1): CpuMemory {
  return {
    rng: new Rng(seedFromId(`${matchId}:cpu:${side}`)),
    seen: new Array<FighterState | null>(HISTORY).fill(null),
    plan: [],
    hold: 0,
    holdLeft: 0,
    nextThink: 0,
    evSt: -1,
    evMove: -1,
    evTick: 0,
    diveRoll: 0,
    cancelRoll: 0,
    wake: Wake.none,
    lastSt: St.idle,
    oppGuard: 0,
    oppOpen: 0,
    oppPokes: 0,
    diveTries: 0,
    diveHits: 0,
    approach: false,
    approachSpeed: 0,
    pokeAt: -1,
    pokeKind: 0,
    pokeScore: [0, 0],
    lastHit: 0,
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

type AttackPhase = "startup" | "active" | "recovery" | null;

function attackPhase(f: FighterState, R: Rules): AttackPhase {
  if (f.st !== St.attack) return null;
  const mv = R.moves[f.move] as MoveRules;
  if (f.stTick <= mv.startup) return "startup";
  if (f.move === Mv.dive_kick ? f.grounded === 0 : f.stTick <= mv.startup + mv.active) return "active";
  return "recovery";
}

/** Ticks the observed opponent is still busy from now (it was seen `delay` ticks ago). */
function busyFor(o: FighterState, delay: number, R: Rules): number {
  let left = 0;
  if (o.st === St.attack) left = (R.moves[o.move] as MoveRules).total - o.stTick;
  else if (o.st === St.land || o.st === St.hitStun || o.st === St.blockStun) left = o.stun + 1;
  return left + o.hitstop - delay;
}

/** Decide this tick's buttons for the CPU playing `side`. Call once per tick, before step(). */
export function cpuThink(s: MatchState, side: 0 | 1, mem: CpuMemory, cfg: CpuConfig, R: Rules = RULES): number {
  const me = s.f[side] as FighterState;
  const real = s.f[1 - side] as FighterState;
  const opp = cpuObserve(mem, s, side, cfg.delay);
  const lastSt = mem.lastSt;
  mem.lastSt = me.st;
  if (s.phase !== Phase.fighting) {
    mem.plan.length = 0;
    mem.holdLeft = 0;
    mem.diveRoll = 0;
    mem.lastHit = s.tick;
    return 0;
  }
  const rng = mem.rng;
  const fwd = me.facing > 0 ? B.R : B.L;
  const back = me.facing > 0 ? B.L : B.R;
  const dist = Math.abs(opp.x - me.x);
  const heatFull = me.heat >= R.heat.max;
  if ((me.hitT === s.tick && me.hitKind === HitKind.hit) || (real.hitT === s.tick && real.hitKind === HitKind.hit)) mem.lastHit = s.tick;
  // Nothing has landed for a while, or it is behind late in the round: stop waiting.
  const restless = s.tick - mem.lastHit > QUIET || (me.hp < real.hp && s.timer < LATE);

  // Habits. How much of its time in range the opponent spends blocking, and how often it attacks there...
  if (dist < CLOSE && opp.grounded === 1) {
    if (opp.st === St.block || opp.st === St.blockStun) mem.oppGuard += 1;
    else mem.oppOpen += 1;
    if (opp.st === St.attack && opp.stTick === 1) mem.oppPokes += 1;
    if (mem.oppGuard + mem.oppOpen > 240) {
      mem.oppGuard >>= 1;
      mem.oppOpen >>= 1;
      mem.oppPokes >>= 1;
    }
  }
  // ...and whether its own jump-ins land (it knows its own results at once).
  if (me.st === St.attack && me.move === Mv.dive_kick && me.stTick === 1) mem.diveTries += 1;
  if (real.hitT === s.tick && real.hitMv === Mv.dive_kick && real.hitKind === HitKind.hit) mem.diveHits += 1;
  if (mem.diveTries > 12) {
    mem.diveTries >>= 1;
    mem.diveHits >>= 1;
  }
  // ...and whether its pokes (out of block stun / at an approach) land, or get stuffed or jumped.
  if (mem.pokeAt >= 0) {
    const k = mem.pokeKind;
    if (real.hitT === s.tick && real.hitKind === HitKind.hit) {
      mem.pokeScore[k] = Math.min(3, (mem.pokeScore[k] as number) + 1);
      mem.pokeAt = -1;
    } else if ((me.hitT === s.tick && me.hitKind === HitKind.hit) || s.tick - mem.pokeAt > 24) {
      mem.pokeScore[k] = Math.max(-3, (mem.pokeScore[k] as number) - 1);
      mem.pokeAt = -1;
    }
  }

  // Airborne: dive (decided once per jump) when the target is ahead within the dive's reach.
  if (me.st === St.jump && me.grounded === 0) {
    clearPlan(mem); // nothing queued on the ground survives the jump
    const dive = R.moves[Mv.dive_kick] as MoveRules;
    const ahead = (opp.x - me.x) * me.facing;
    if (!me.diveUsed && me.stTick >= dive.minAirTick && me.y >= dive.minY && ahead > me.y - 1400 && ahead < me.y + 700) {
      if (mem.diveRoll === 0) mem.diveRoll = rng.chance(cfg.aggression + 30) ? 1 : 2;
      if (mem.diveRoll === 1) return (s.tick & 1) === 0 ? B.S : 0;
    }
    return 0;
  }
  mem.diveRoll = 0;

  const actionable = me.grounded === 1 && (me.st === St.idle || me.st === St.walkF || me.st === St.walkB || me.st === St.block);
  if (!actionable) {
    if (mem.plan.length > 0) return mem.plan.shift() as number;
    // A peck that hit and filled the meter: cancel it into the super.
    if (me.st === St.attack && me.hitDone === 1 && heatFull) {
      const mv = R.moves[me.move] as MoveRules;
      if ((mv.cancelMask & (1 << Mv.super)) !== 0 && me.stTick >= mv.cancelFrom && me.stTick < mv.cancelTo) {
        if (mem.cancelRoll === 0) mem.cancelRoll = rng.chance(cfg.punishPct) ? 1 : 2;
        if (mem.cancelRoll === 1) return press(mem, B.S);
      }
    } else mem.cancelRoll = 0;
    // Hit stun, block stun and get-up: decide once, as they start, how to come out, and act on the
    // first free tick: keep a guard up through it, or press Space in its last ticks (the press is
    // buffered) to poke or super at once, or tap back twice to dash out. Otherwise let go, so the
    // next press is an edge.
    if (me.st === St.hitStun || me.st === St.blockStun || me.st === St.getup) {
      // A hit or a block tells it where the attacker is (it felt it): judge the distance from that.
      if (lastSt !== me.st) mem.wake = wakePlan(me, opp, mem, cfg, R, me.st === St.getup ? dist : Math.abs(real.x - me.x), heatFull);
      const free = freeIn(me, R);
      if (mem.wake === Wake.poke || mem.wake === Wake.super) {
        if (free > 3) return 0;
        if (mem.wake === Wake.poke && mem.pokeAt < 0) {
          mem.pokeAt = s.tick;
          mem.pokeKind = 0;
        }
        return (s.tick & 1) === 0 ? B.S : 0;
      }
      if (mem.wake === Wake.dash) return free === 3 || free === 1 ? back : 0;
      return mem.wake === Wake.guard ? B.D : 0;
    }
    return 0;
  }
  mem.cancelRoll = 0;

  // 1. Reactions. Each observed opponent action is judged once, the first time the CPU is free to
  // act on it: an action continues while its state and move hold and its frame counts up.
  const fresh = opp.st !== mem.evSt || opp.move !== mem.evMove || opp.stTick < mem.evTick;
  mem.evSt = opp.st;
  mem.evMove = opp.move;
  mem.evTick = opp.stTick;
  if (fresh) {
    const r = react(me, opp, mem, cfg, R, dist, fwd, back, heatFull);
    if (r >= 0) return r;
  }
  // An opponent walking into its reach: poke them as they arrive (judged once per approach; less
  // often once those pokes keep getting stuffed or jumped over).
  if ((opp.st === St.walkF || opp.st === St.dashF) && fresh && mem.plan.length === 0) {
    const speed = opp.st === St.dashF ? R.fighter.dashFwdSpeed : R.fighter.walkFwd;
    mem.approach = rng.chance(cfg.footsies + mulDiv((mem.pokeScore[1] as number) * 25, cfg.punishPct, 100));
    if (mem.approach) mem.approachSpeed = speed;
  }
  if (mem.approach && (opp.st === St.walkF || opp.st === St.dashF) && mem.plan.length === 0) {
    const soon = dist - mem.approachSpeed * (cfg.delay + 4);
    if (soon < PECK_REACH && dist > 1150) {
      mem.approach = false;
      clearPlan(mem);
      return poke(mem, s.tick, 1);
    }
  }
  // Just out of stun or get-up, having guarded through it: keep guarding a little longer.
  if (lastSt === St.hitStun || lastSt === St.blockStun || lastSt === St.getup) {
    const w = mem.wake;
    mem.wake = Wake.none;
    if (w === Wake.guard && dist < THREAT) return holdFor(mem, B.D, 4 + rng.int(8));
  }

  if (mem.plan.length > 0) return mem.plan.shift() as number;
  if (mem.holdLeft > 0) {
    mem.holdLeft -= 1;
    return mem.hold;
  }

  // 2. Neutral, re-decided every `think` ticks.
  if (s.tick < mem.nextThink) return me.st === St.walkF ? fwd : me.st === St.walkB ? back : me.st === St.block ? B.D : 0;
  mem.nextThink = s.tick + cfg.think + rng.int(cfg.think);
  return neutral(me, opp, mem, cfg, R, dist, fwd, back, heatFull, restless);
}

/** React to a fresh observation. Returns a mask, or -1 for nothing to react to. */
function react(
  me: FighterState,
  opp: FighterState,
  mem: CpuMemory,
  cfg: CpuConfig,
  R: Rules,
  dist: number,
  fwd: number,
  back: number,
  heatFull: boolean,
): number {
  const rng = mem.rng;
  const phase = attackPhase(opp, R);
  const mv = opp.st === St.attack ? (R.moves[opp.move] as MoveRules) : null;

  if (phase === "startup" && mv && opp.grounded === 1) {
    // Ticks until the attack's first active frame, in real time (it was seen `delay` ticks ago).
    const until = mv.startup + 1 - opp.stTick - cfg.delay;
    if (mv.id === Mv.slam) {
      // Unblockable: jump it (airborne by its first active frame), or peck it out of its long startup.
      if (dist >= THREAT || until < 0 || !rng.chance(cfg.blockPct)) return -1;
      clearPlan(mem);
      return dist < PECK_REACH && until >= 5 && rng.chance(50) ? press(mem, B.S) : holdFor(mem, B.U | back, 2);
    }
    // Too late to guard it (a peck is faster than any CPU's eyes): it has to be guarded in advance.
    if (until + mv.active <= 1) return -1;
    if (mv.blockable && (dist < THREAT || mv.fullScreenMaxY > 0)) {
      if (heatFull && rng.chance(cfg.blockPct >> 1)) {
        clearPlan(mem);
        return press(mem, B.S); // the super is invulnerable through the attack
      }
      if (!rng.chance(cfg.blockPct)) return -1;
      clearPlan(mem);
      return holdFor(mem, B.D, mv.startup + mv.active - opp.stTick + 8);
    }
    return -1;
  }

  // A jump or a dive kick coming at it (the dive is unblockable, and a peck loses to it): dash
  // under it (then punish the landing), or jump away without diving back.
  const diving = opp.st === St.attack && opp.move === Mv.dive_kick && opp.grounded === 0 && opp.facing * (me.x - opp.x) > 0;
  if (diving || (opp.st === St.jump && opp.grounded === 0 && dist < 3400 && (opp.vx * (me.x - opp.x) > 0 || dist < 2000))) {
    if (!rng.chance(cfg.antiAirPct)) return -1;
    if ((dist < 2800 && rng.chance(70)) || nearWall(me, R)) return dash(mem, me, fwd);
    clearPlan(mem);
    mem.diveRoll = 2;
    return holdFor(mem, B.U | back, 1);
  }

  // A whiff or a landing it can still reach: punish it. The super reaches anywhere; a peck or slam
  // if it is in range; a dash in and a peck if the opponent is busy long enough for that (18 ticks).
  if (phase === "recovery" || opp.st === St.land) {
    const left = busyFor(opp, cfg.delay, R);
    const superOk = heatFull && left > (R.moves[Mv.super] as MoveRules).startup;
    const dashReach = PECK_REACH + R.fighter.dashFwdSpeed * R.fighter.dashFwdFrames;
    const near = dist < PECK_REACH && left >= 5;
    const dashIn = !near && dist < dashReach && left >= 20;
    if (!(superOk || near || dashIn) || !rng.chance(cfg.punishPct)) return -1;
    clearPlan(mem);
    if (superOk) return press(mem, B.S);
    if (dashIn) {
      // Release, tap, release, tap (the dash starts on the second tap); Space late in the dash is buffered to its end.
      mem.plan.push(fwd, 0, fwd, 0, 0, 0, 0, 0, 0, 0, 0, 0, B.S, 0);
      return 0;
    }
    if (left >= 15 && dist < SLAM_RANGE) return press(mem, B.D | B.S);
    return press(mem, B.S);
  }
  return -1;
}

function neutral(
  me: FighterState,
  opp: FighterState,
  mem: CpuMemory,
  cfg: CpuConfig,
  R: Rules,
  dist: number,
  fwd: number,
  back: number,
  heatFull: boolean,
  restless: boolean,
): number {
  const rng = mem.rng;
  const oppNearWall = Math.abs(opp.x) > 7000 && Math.abs(opp.x) > Math.abs(me.x);

  // An opponent who keeps attacking in range: guard (and hit back out of block stun, see wakePlan).
  if (!restless && dist < THREAT && pokey(mem) && rng.chance(cfg.blockPct)) return holdFor(mem, B.D, 16 + rng.int(12));
  // An opponent coming at it: hold the ground (guard, or wait for it to walk into a poke) rather
  // than walk into its reach.
  if (!restless && dist > CLOSE && dist < HOLD_GROUND && (opp.st === St.walkF || opp.st === St.dashF)) {
    return rng.chance(cfg.blockPct >> 1) ? holdFor(mem, B.D, 6 + rng.int(6)) : holdFor(mem, 0, 3 + rng.int(4));
  }
  if (dist > JUMP_IN_MAX) {
    if (rng.chance(12)) return dash(mem, me, fwd);
    return walkIn(mem, fwd, 8 + rng.int(12), dist, R, restless);
  }
  if (dist > CLOSE) {
    // Mid range. Jump in (more often when its jump-ins land), creep in, wait, or give ground.
    let jumpIn = cfg.aggression >> 2;
    if (mem.diveTries >= 2) jumpIn += mulDiv(mulDiv(mem.diveHits, 50, mem.diveTries), cfg.punishPct, 100);
    if (dist > JUMP_IN_MIN && rng.chance(jumpIn)) return holdFor(mem, B.U | fwd, 2);
    const r = rng.int(100);
    if (r < 55) return walkIn(mem, fwd, 4 + rng.int(8), dist, R, restless);
    if (r < 70 && !nearWall(me, R)) return holdFor(mem, back, 4 + rng.int(6));
    if (r < 80) return holdFor(mem, B.D, 6 + rng.int(8));
    return 0;
  }

  // In range. Guard some of the time (more on higher levels); otherwise attack (less against a
  // super threat: the super is invulnerable, so attacking into it loses), or give ground back to
  // just outside the opponent's reach and wait for them to walk into a poke.
  const threat = superThreat(opp, R);
  if (rng.chance(restless ? cfg.blockPct >> 2 : cfg.blockPct >> 1)) return holdFor(mem, B.D, 8 + rng.int(10));
  const aggression = restless ? cfg.aggression + 30 : cfg.aggression;
  if (!rng.chance(threat ? aggression >> 1 : aggression)) {
    if (nearWall(me, R) || !rng.chance(cfg.footsies)) return 0;
    if (dist < 1100) return dash(mem, me, back);
    return holdFor(mem, back, 2 + idiv(CLOSE + 100 - dist, R.fighter.walkBack));
  }
  if (heatFull && rng.chance(40)) return press(mem, B.S);
  // Against a blocker the slam (unblockable) comes out more.
  const guardy = mem.oppGuard * 100 > (mem.oppGuard + mem.oppOpen + 1) * 40;
  const r = rng.int(100);
  if (dist < SLAM_RANGE && r < (guardy ? 45 : 15)) return press(mem, B.D | B.S);
  if (oppNearWall && r < 60 && dist < 1300) return press(mem, fwd | B.S);
  if (dist > PECK_REACH - 50) return holdFor(mem, fwd, 3 + rng.int(4));
  if (r < 85 || dist >= 1300) return press(mem, B.S);
  return press(mem, fwd | B.S);
}

/**
 * How to come out of a hit stun, block stun or get-up, decided as it starts (the CPU knows its
 * own state at once). Out of block stun it is usually ahead (a blocked peck is -1): hit back
 * first, much more against an opponent who keeps attacking in range. Out of hit stun the attacker
 * usually moves first: guard. Waking up, an invulnerable super at full Heat, or guard.
 */
function wakePlan(me: FighterState, opp: FighterState, mem: CpuMemory, cfg: CpuConfig, R: Rules, dist: number, heatFull: boolean): number {
  const rng = mem.rng;
  if (dist >= THREAT) return Wake.none;
  if (heatFull && me.st !== St.blockStun && rng.chance(me.st === St.getup ? cfg.punishPct >> 1 : cfg.punishPct >> 2)) return Wake.super;
  if (me.st === St.blockStun) {
    let pct = cfg.aggression + mulDiv(mem.pokeScore[0] as number, 15 * cfg.punishPct, 100);
    pct += pokey(mem) ? cfg.footsies : mulDiv(cfg.footsies, 30, 100);
    if (dist < PECK_REACH && !superThreat(opp, R) && rng.chance(pct)) return Wake.poke;
    if (!rng.chance(cfg.blockPct)) return Wake.none;
    return nearWall(me, R) || rng.chance(70) ? Wake.guard : Wake.dash;
  }
  if (rng.chance(cfg.blockPct)) return Wake.guard;
  return me.st === St.hitStun && rng.chance(cfg.aggression >> 2) ? Wake.poke : Wake.none;
}

/** Steps until the fighter acts again: 1 means the next step() is its first free tick. */
function freeIn(me: FighterState, R: Rules): number {
  if (me.st === St.getup) return me.hitstop + R.fighter.getup - me.stTick + 1;
  return me.hitstop + me.stun + 1;
}

/**
 * Walk forward up to `ticks`, stopping short of its peck reach (it last saw the opponent `dist`
 * away, and the opponent may have come closer since); restless, it walks into its reach. Too
 * close already: guard a moment instead.
 */
function walkIn(mem: CpuMemory, fwd: number, ticks: number, dist: number, R: Rules, restless: boolean): number {
  const n = Math.min(ticks, idiv(dist - (restless ? PECK_REACH - 150 : WALK_STOP), R.fighter.walkFwd));
  if (n < 2) return holdFor(mem, B.D, 3 + mem.rng.int(4));
  return holdFor(mem, fwd, n);
}

/** The opponent attacks a lot when in range (more than once every 45 ticks there). */
function pokey(mem: CpuMemory): boolean {
  const ticks = mem.oppGuard + mem.oppOpen;
  return ticks > 60 && mem.oppPokes * 45 > ticks;
}

/** The opponent can super now, or after one more clean hit (a peck that fills the meter cancels into it). */
function superThreat(o: FighterState, R: Rules): boolean {
  return o.heat >= R.heat.max - R.heat.onHit;
}

function nearWall(f: FighterState, R: Rules): boolean {
  return Math.abs(f.x) > R.match.wallEdge - 1500;
}

function clearPlan(mem: CpuMemory): void {
  mem.plan.length = 0;
  mem.holdLeft = 0;
}

/** Peck, and remember to score how it went. */
function poke(mem: CpuMemory, tick: number, kind: number): number {
  mem.pokeAt = tick;
  mem.pokeKind = kind;
  return press(mem, B.S);
}

/** Press a button combination for one tick, then release (a clean edge). */
function press(mem: CpuMemory, mask: number): number {
  mem.plan.push(0);
  return mask;
}

/** Double-tap a direction: tap, release, tap (the first tap must be a fresh press: release it first if held). */
function dash(mem: CpuMemory, me: FighterState, dir: number): number {
  clearPlan(mem);
  if ((me.rawHeld & dir) === 0) {
    mem.plan.push(0, dir, 0);
    return dir;
  }
  mem.plan.push(dir, 0, dir, 0);
  return 0;
}

function holdFor(mem: CpuMemory, mask: number, ticks: number): number {
  mem.hold = mask;
  mem.holdLeft = ticks - 1;
  return mask;
}
