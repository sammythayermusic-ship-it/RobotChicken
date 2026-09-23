import { B, BUTTON_MASK, type FighterState } from "./types";
import type { Rules } from "./rules";

/** SOCD cleaning: opposite directions held together cancel out. */
export function cleanButtons(raw: number): number {
  let v = raw & BUTTON_MASK;
  if (v & B.L && v & B.R) v &= ~(B.L | B.R);
  if (v & B.U && v & B.D) v &= ~(B.U | B.D);
  return v;
}

/** Direction bits a buffered Space press remembers (world space; toward is resolved when the move fires). */
const BUF_DIRS = B.L | B.R | B.D;

/**
 * Edge detection, dash taps and the Space buffer. Runs every tick, including
 * during hit-stop (edges are still read), but the buffer does not drain while
 * frozen so a hit-stop cannot eat a buffered press.
 *
 * Press edges come from the raw keys: SOCD cleaning would invent edges (hold
 * ←, tap → twice: releasing → brings ← "back" as a new press). Walking,
 * blocking, jumping and move choice use the cleaned `held`.
 */
export function readInput(f: FighterState, rawIn: number, frozen: boolean, R: Rules): void {
  const raw = rawIn & BUTTON_MASK;
  const now = cleanButtons(raw);
  const pressed = raw & ~f.rawHeld;
  const win = R.fighter.dashWindow;

  f.tapL = f.tapL < 255 ? f.tapL + 1 : 255;
  f.tapR = f.tapR < 255 ? f.tapR + 1 : 255;
  let dashL = false;
  let dashR = false;
  if (pressed & B.L) {
    if (f.tapL <= win) {
      dashL = true;
      f.tapL = 255; // a third tap starts a new pair instead of dashing again
    } else f.tapL = 0;
  }
  if (pressed & B.R) {
    if (f.tapR <= win) {
      dashR = true;
      f.tapR = 255;
    } else f.tapR = 0;
  }
  // Both directions completing a double tap on the same tick cancel out, like SOCD.
  f.dashReq = dashL === dashR ? 0 : dashL ? -1 : 1;

  if (pressed & B.S) {
    f.bufS = R.fighter.inputBuffer;
    // The move is chosen from what was held when Space went down, not when it fires.
    f.bufDir = now & BUF_DIRS;
  } else if (!frozen && f.bufS > 0) {
    f.bufS -= 1;
    if (f.bufS === 0) f.bufDir = 0;
  }

  f.held = now;
  f.rawHeld = raw;
}

/** Held direction relative to facing. */
export function holdsFwd(f: FighterState): boolean {
  return (f.held & (f.facing > 0 ? B.R : B.L)) !== 0;
}
export function holdsBack(f: FighterState): boolean {
  return (f.held & (f.facing > 0 ? B.L : B.R)) !== 0;
}
