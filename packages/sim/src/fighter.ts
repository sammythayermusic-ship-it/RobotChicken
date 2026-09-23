import { holdsBack, holdsFwd } from "./input";
import type { Rules } from "./rules";
import { Mv, St, type FighterState, type StId } from "./types";

export function setState(f: FighterState, st: StId): void {
  if (f.st !== st) {
    f.st = st;
    f.stTick = 0;
  }
}

/** Neutral states from which any action can start. */
export function actionable(f: FighterState): boolean {
  return f.grounded === 1 && (f.st === St.idle || f.st === St.walkF || f.st === St.walkB || f.st === St.block);
}

/**
 * Per-fighter state transitions and velocity for this tick.
 * Phase 0: neutral movement only (walk / idle). Phase 1 adds the move set.
 */
export function updateFighter(f: FighterState, live: boolean, R: Rules): void {
  f.stTick += 1;
  if (live && actionable(f)) {
    if (holdsFwd(f)) {
      setState(f, St.walkF);
      f.vx = f.facing * R.fighter.walkFwd;
    } else if (holdsBack(f)) {
      setState(f, St.walkB);
      f.vx = -f.facing * R.fighter.walkBack;
    } else {
      setState(f, St.idle);
      f.vx = 0;
    }
  } else if (actionable(f)) {
    setState(f, St.idle);
    f.vx = 0;
  }
  f.move = Mv.none;
}
