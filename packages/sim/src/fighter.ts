/**
 * Per-fighter state machine: timers, end-of-state transitions, action choice
 * and velocity for one tick. Runs before movement and hit detection.
 *
 * Frame convention: `stTick` is 1 on the tick a state (or attack) starts. An
 * attack's active frames are startup+1 .. startup+active; it lasts exactly
 * startup+active+recovery ticks and the fighter can act again on the next.
 */
import { holdsBack, holdsFwd } from "./input";
import type { MoveRules, Rules } from "./rules";
import { B, Mv, St, type FighterState, type MvId, type StId } from "./types";

/** Enter a state on this tick (stTick = 1). */
export function enter(f: FighterState, st: StId): void {
  f.st = st;
  f.stTick = 1;
}

/** Switch state only if different (continuing states keep their stTick). */
function keep(f: FighterState, st: StId): void {
  if (f.st !== st) enter(f, st);
}

/** Neutral grounded states from which any action can start. */
export function actionable(f: FighterState): boolean {
  return f.grounded === 1 && (f.st === St.idle || f.st === St.walkF || f.st === St.walkB || f.st === St.block);
}

export function moveOf(f: FighterState, R: Rules): MoveRules {
  return R.moves[f.move] as MoveRules;
}

/** Attack frame is in its active window (dive kick: until it lands). */
export function inActiveFrames(f: FighterState, mv: MoveRules): boolean {
  if (f.st !== St.attack) return false;
  const first = mv.startup + 1;
  if (mv.id === Mv.dive_kick) return f.stTick >= first && f.grounded === 0;
  return f.stTick >= first && f.stTick <= mv.startup + mv.active;
}

/** True while the fighter's hurtbox is switched off. */
export function isInvulnerable(f: FighterState, R: Rules): boolean {
  if (f.invuln > 0) return true;
  switch (f.st) {
    case St.knockdown:
    case St.getup:
    case St.launched:
    case St.ko:
    case St.ringOut:
      return true;
    case St.dashF:
    case St.dashB:
      return f.stTick >= R.fighter.dashInvuln[0] && f.stTick <= R.fighter.dashInvuln[1];
    case St.attack: {
      const mv = moveOf(f, R);
      return mv.invuln[1] > 0 && f.stTick >= mv.invuln[0] && f.stTick <= mv.invuln[1];
    }
    default:
      return false;
  }
}

function startAttack(f: FighterState, id: MvId, R: Rules): void {
  const mv = R.moves[id] as MoveRules;
  enter(f, St.attack);
  f.move = id;
  f.hitDone = 0;
  f.bufS = 0;
  f.vx = 0;
  if (mv.heatCost > 0) f.heat = 0;
  if (id === Mv.dive_kick) {
    f.diveUsed = 1;
    f.vy = 0; // hover during startup
  }
}

function heatFull(f: FighterState, R: Rules): boolean {
  return f.heat >= R.heat.max;
}

/** Grounded Space priority: super (full Heat, neutral) > slam (down) > shove (toward) > peck. */
function groundAttackFor(f: FighterState, R: Rules): MvId {
  const down = (f.held & B.D) !== 0;
  const fwd = holdsFwd(f);
  if (heatFull(f, R) && !down && !fwd) return Mv.super;
  if (down) return Mv.slam;
  if (fwd) return Mv.shove;
  return Mv.peck;
}

function jump(f: FighterState, R: Rules): void {
  enter(f, St.jump);
  f.grounded = 0;
  f.vy = R.fighter.jumpVy;
  f.vx = holdsFwd(f) ? f.facing * R.fighter.jumpVxFwd : holdsBack(f) ? -f.facing * R.fighter.jumpVxBack : 0;
  f.diveUsed = 0;
}

/** Pick and start an action from a neutral grounded state. */
function neutral(f: FighterState, R: Rules): void {
  const F = R.fighter;
  if (f.bufS > 0) {
    startAttack(f, groundAttackFor(f, R), R);
    return;
  }
  if (f.dashReq !== 0) {
    enter(f, f.dashReq === f.facing ? St.dashF : St.dashB);
    f.vx = 0;
    return;
  }
  if (f.held & B.U) {
    jump(f, R);
    return;
  }
  if (f.held & B.D) {
    keep(f, St.block);
    f.vx = 0;
  } else if (holdsFwd(f)) {
    keep(f, St.walkF);
    f.vx = f.facing * F.walkFwd;
  } else if (holdsBack(f)) {
    keep(f, St.walkB);
    f.vx = -f.facing * F.walkBack;
  } else {
    keep(f, St.idle);
    f.vx = 0;
  }
}

/** Cancel a connected attack into another move inside its cancel window. */
function tryCancel(f: FighterState, R: Rules): boolean {
  const mv = moveOf(f, R);
  if (!f.hitDone || mv.cancelMask === 0 || f.bufS === 0) return false;
  if (f.stTick < mv.cancelFrom || f.stTick > mv.cancelTo) return false;
  const want = groundAttackFor(f, R);
  if ((mv.cancelMask & (1 << want)) === 0) return false;
  startAttack(f, want, R);
  return true;
}

function toNeutral(f: FighterState): void {
  enter(f, St.idle);
  f.move = Mv.none;
  f.vx = 0;
}

/**
 * Advance one fighter's state by a tick. `live` is false during countdown and
 * round end: states still play out, but no new actions start.
 * Frozen (hit-stop) fighters are handled by the caller and never get here.
 */
export function updateFighter(f: FighterState, live: boolean, R: Rules): void {
  const F = R.fighter;
  f.stTick += 1;
  if (f.invuln > 0) f.invuln -= 1;

  // 1. End-of-state transitions and per-state timers.
  switch (f.st) {
    case St.attack: {
      const mv = moveOf(f, R);
      if (f.stTick > mv.total) toNeutral(f);
      break;
    }
    case St.hitStun:
    case St.blockStun:
      if (f.stun > 0) f.stun -= 1;
      else if (f.grounded) toNeutral(f);
      else enter(f, St.fall);
      break;
    case St.land:
      if (f.stun > 0) f.stun -= 1;
      else toNeutral(f);
      break;
    case St.dashF:
    case St.dashB:
      if (f.stTick > F.dashDuration) toNeutral(f);
      break;
    case St.knockdown:
      if (f.stTick > F.knockdownLie) {
        enter(f, St.getup);
        f.invuln = F.getup;
      }
      break;
    case St.getup:
      if (f.stTick > F.getup) toNeutral(f);
      break;
    default:
      break;
  }

  // 2. Actions.
  if (live) {
    if (actionable(f)) neutral(f, R);
    else if (f.st === St.attack && f.grounded) tryCancel(f, R);
    else if (f.st === St.jump && f.grounded === 0 && f.bufS > 0 && !f.diveUsed) {
      const dive = R.moves[Mv.dive_kick] as MoveRules;
      if (f.stTick >= dive.minAirTick && f.y >= dive.minY) startAttack(f, Mv.dive_kick, R);
    }
  } else if (actionable(f)) {
    keep(f, St.idle);
    f.vx = 0;
  }

  // 3. Velocity for states that drive their own motion.
  switch (f.st) {
    case St.dashF:
      f.vx = f.stTick <= F.dashFwdFrames ? f.facing * F.dashFwdSpeed : 0;
      break;
    case St.dashB:
      f.vx = f.stTick <= F.dashBackFrames ? -f.facing * F.dashBackSpeed : 0;
      break;
    case St.attack: {
      const mv = moveOf(f, R);
      if (mv.id === Mv.dive_kick && f.grounded === 0) {
        if (f.stTick <= mv.startup) {
          f.vx = 0;
          f.vy = 0;
        } else {
          f.vx = f.facing * mv.dive[0];
          f.vy = mv.dive[1];
        }
      } else if (f.grounded) f.vx = 0;
      break;
    }
    case St.hitStun:
    case St.blockStun:
    case St.land:
    case St.knockdown:
    case St.getup:
    case St.ko:
    case St.win:
      if (f.grounded) f.vx = 0;
      break;
    default:
      break;
  }
}

/** True when gravity applies this tick (airborne and not in a dive). */
export function usesGravity(f: FighterState): boolean {
  if (f.grounded) return false;
  if (f.st === St.attack && f.move === Mv.dive_kick) return false;
  return true;
}

/** Touchdown handling after vertical integration put the fighter on the floor. */
export function onLanding(f: FighterState, R: Rules): void {
  f.grounded = 1;
  f.y = 0;
  f.vy = 0;
  f.roAble = 0;
  f.diveUsed = 0;
  switch (f.st) {
    case St.attack:
      if (f.move === Mv.dive_kick) {
        const mv = moveOf(f, R);
        // Skip the rest of the active window: recovery frames start next tick.
        f.stTick = mv.startup + mv.active;
      }
      f.vx = 0;
      break;
    case St.launched:
      enter(f, St.knockdown);
      f.vx = 0;
      break;
    case St.ko:
    case St.win:
      f.vx = 0;
      break;
    case St.hitStun:
    case St.blockStun:
      f.vx = 0;
      break;
    default:
      enter(f, St.land);
      f.stun = R.fighter.landLag;
      f.vx = 0;
      f.move = Mv.none;
      break;
  }
}
