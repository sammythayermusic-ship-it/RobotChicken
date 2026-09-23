import { sgn } from "./fixed";
import { onLanding, usesGravity } from "./fighter";
import type { Rules } from "./rules";
import { St, type FighterState, type MatchState } from "./types";

/**
 * The wall stops OUTWARD motion past |x| = wallEdge unless a ring-out capable
 * hit set `roAble`. A fighter already beyond the wall (a ring-out hit that fell
 * short) stays where it is and can walk back in: no teleporting.
 */
export function wallClamp(f: FighterState, oldX: number, R: Rules): void {
  if (f.roAble) return;
  const w = R.match.wallEdge;
  const ax = Math.abs(f.x);
  if (ax > w && ax > Math.abs(oldX)) f.x = sgn(f.x) * Math.max(w, Math.abs(oldX));
}

/** Advance one fighter by its velocity, knockback slide and gravity. */
export function integrate(f: FighterState, R: Rules): void {
  const oldX = f.x;
  let dx = f.vx;
  if (f.slideRem > 0) {
    const mag = Math.min(Math.abs(f.slideV), f.slideRem);
    dx += sgn(f.slideV) * mag;
    f.slideRem -= mag;
    if (f.slideRem === 0) {
      f.slideV = 0;
      if (f.grounded && f.st !== St.ringOut) f.roAble = 0;
    }
  }
  f.x += dx;
  wallClamp(f, oldX, R);

  // Past the ring edge there is no floor: whoever is out there falls.
  const offStage = Math.abs(f.x) > R.match.ringEdge;
  if (offStage) f.grounded = 0;
  if (!f.grounded) {
    f.y += f.vy;
    if (usesGravity(f)) f.vy -= R.fighter.gravity;
    if (offStage || f.st === St.ringOut) {
      if (f.y < R.match.ringOutFloor) {
        f.y = R.match.ringOutFloor;
        f.vy = 0;
      }
    } else if (f.y <= 0) onLanding(f, R);
  }
}

/**
 * Pushbox separation on x. Symmetric: each fighter moves half the overlap,
 * rounded up, so swapping the players mirrors the result exactly. If a wall
 * stops one fighter, the other takes the remainder.
 */
export function resolvePush(s: MatchState, R: Rules): void {
  const a = s.f[0];
  const b = s.f[1];
  const halfW = R.fighter.pushHalfW;
  if (Math.abs(a.y - b.y) >= R.fighter.pushH) return; // one passes over the other
  if (a.st === St.ringOut || b.st === St.ringOut) return;
  const dx = b.x - a.x;
  const overlap = 2 * halfW - Math.abs(dx);
  if (overlap <= 0) return;
  // Direction b moves: away from a. On an exact tie, split by facing (P1 left if equal).
  let dir = sgn(dx);
  if (dir === 0) dir = a.facing < 0 && b.facing > 0 ? -1 : 1;
  const half = (overlap + 1) >> 1;
  const ax0 = a.x;
  const bx0 = b.x;
  a.x -= dir * half;
  b.x += dir * half;
  wallClamp(a, ax0, R);
  wallClamp(b, bx0, R);
  const aShort = half - Math.abs(a.x - ax0);
  const bShort = half - Math.abs(b.x - bx0);
  if (aShort > 0) {
    const bx1 = b.x;
    b.x += dir * aShort;
    wallClamp(b, bx1, R);
  }
  if (bShort > 0) {
    const ax1 = a.x;
    a.x -= dir * bShort;
    wallClamp(a, ax1, R);
  }
}

/** Grounded fighters in neutral states always face the opponent. */
export function faceOpponents(s: MatchState): void {
  for (let i = 0; i < 2; i++) {
    const f = s.f[i] as FighterState;
    const o = s.f[1 - i] as FighterState;
    if (!f.grounded) continue;
    if (f.st !== St.idle && f.st !== St.walkF && f.st !== St.walkB && f.st !== St.block && f.st !== St.land) continue;
    const d = sgn(o.x - f.x);
    if (d !== 0) f.facing = d;
  }
}
