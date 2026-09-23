import { B, BUTTON_MASK, type FighterState } from "./types";
import type { Rules } from "./rules";

/** SOCD cleaning: opposite directions held together cancel out. */
export function cleanButtons(raw: number): number {
  let v = raw & BUTTON_MASK;
  if (v & B.L && v & B.R) v &= ~(B.L | B.R);
  if (v & B.U && v & B.D) v &= ~(B.U | B.D);
  return v;
}

/**
 * Edge detection, dash taps and the Space buffer. Runs every tick, including
 * during hit-stop (edges are still read), but the buffer does not drain while
 * frozen so a hit-stop cannot eat a buffered press.
 */
export function readInput(f: FighterState, raw: number, frozen: boolean, R: Rules): void {
  const now = cleanButtons(raw);
  const pressed = now & ~f.held;
  const win = R.fighter.dashWindow;

  f.dashReq = 0;
  f.tapL = f.tapL < 255 ? f.tapL + 1 : 255;
  f.tapR = f.tapR < 255 ? f.tapR + 1 : 255;
  if (pressed & B.L) {
    if (f.tapL <= win) {
      f.dashReq = -1;
      f.tapL = 255; // a third tap starts a new pair instead of dashing again
    } else f.tapL = 0;
  }
  if (pressed & B.R) {
    if (f.tapR <= win) {
      f.dashReq = 1;
      f.tapR = 255;
    } else f.tapR = 0;
  }

  if (pressed & B.S) f.bufS = R.fighter.inputBuffer;
  else if (!frozen && f.bufS > 0) f.bufS -= 1;

  f.held = now;
}

/** Held direction relative to facing. */
export function holdsFwd(f: FighterState): boolean {
  return (f.held & (f.facing > 0 ? B.R : B.L)) !== 0;
}
export function holdsBack(f: FighterState): boolean {
  return (f.held & (f.facing > 0 ? B.L : B.R)) !== 0;
}
