import { clamp, sgn } from "./fixed";
import type { Rules } from "./rules";
import { St, type FighterState, type MatchState } from "./types";

/** Horizontal bound for self-propelled motion (ring-out needs a ring-out hit). */
export function wallClamp(f: FighterState, R: Rules): void {
  if (f.roAble) return;
  const w = R.match.wallEdge;
  f.x = clamp(f.x, -w, w);
}

/** Advance one fighter's position by its velocity and knockback slide. */
export function integrate(f: FighterState, R: Rules): void {
  let dx = f.vx;
  if (f.slideRem > 0) {
    const mag = Math.min(Math.abs(f.slideV), f.slideRem);
    dx += sgn(f.slideV) * mag;
    f.slideRem -= mag;
    if (f.slideRem === 0) f.slideV = 0;
  }
  f.x += dx;
  wallClamp(f, R);
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
  wallClamp(a, R);
  wallClamp(b, R);
  const aShort = half - Math.abs(a.x - ax0);
  const bShort = half - Math.abs(b.x - bx0);
  if (aShort > 0) {
    b.x += dir * aShort;
    wallClamp(b, R);
  }
  if (bShort > 0) {
    a.x -= dir * bShort;
    wallClamp(a, R);
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
