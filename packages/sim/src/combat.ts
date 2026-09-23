/**
 * Hit detection and resolution. Both directions are detected before either is
 * applied, so trades are symmetric and P1 never gets priority.
 */
import { clipFor, sampleFor } from "./anim";
import { capsuleHitsCircle } from "./collide";
import { idiv, mulDiv, sgn } from "./fixed";
import { enter, inActiveFrames, isInvulnerable, moveOf } from "./fighter";
import { endRound } from "./round";
import type { ClipRules, MoveRules, Rules } from "./rules";
import { HitKind, Mv, Reason, St, type FighterState, type MatchState } from "./types";

export interface Hurt {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  r: number;
}

/** World-space hurt capsule for this tick. */
export function hurtOf(f: FighterState, R: Rules): Hurt {
  const clip = R.clips[clipFor(f, R)] as ClipRules;
  if (clip.hurt) {
    const k = sampleFor(f, clip, R) * 5;
    const h = clip.hurt;
    return {
      ax: f.x + f.facing * (h[k] as number),
      ay: f.y + (h[k + 1] as number),
      bx: f.x + f.facing * (h[k + 2] as number),
      by: f.y + (h[k + 3] as number),
      r: h[k + 4] as number,
    };
  }
  const d = R.fighter.hurtFallback;
  return { ax: f.x + f.facing * d.ax, ay: f.y + d.ay, bx: f.x + f.facing * d.bx, by: f.y + d.by, r: d.r };
}

/** World-space hit sphere of an attacking fighter this tick: [x, y, r]. */
export function hitOf(f: FighterState, mv: MoveRules, R: Rules): [number, number, number] {
  const clip = R.clips[mv.clip] as ClipRules;
  if (mv.hit) {
    const k = sampleFor(f, clip, R) * 3;
    const h = mv.hit;
    return [f.x + f.facing * (h[k] as number), f.y + (h[k + 1] as number), h[k + 2] as number];
  }
  return [f.x + f.facing * mv.box.x, f.y + mv.box.y, mv.box.r];
}

/** Does attacker `a` connect with defender `d` this tick? */
export function detect(a: FighterState, d: FighterState, frozenA: boolean, R: Rules): boolean {
  if (frozenA || a.st !== St.attack || a.hitDone) return false;
  const mv = moveOf(a, R);
  if (!inActiveFrames(a, mv)) return false;
  if (isInvulnerable(d, R)) return false;
  if (!mv.hitsAir && !d.grounded) return false;
  if (mv.fullScreenMaxY > 0) return d.y <= mv.fullScreenMaxY;
  const [hx, hy, hr] = hitOf(a, mv, R);
  const h = hurtOf(d, R);
  return capsuleHitsCircle(h.ax, h.ay, h.bx, h.by, h.r, hx, hy, hr);
}

function blocks(d: FighterState, mv: MoveRules): boolean {
  return mv.blockable && d.grounded === 1 && (d.st === St.block || d.st === St.blockStun);
}

interface Slide {
  dist: number;
  speed: number;
}

/**
 * Apply every detected hit. `hits[i]` means fighter i hit fighter 1-i.
 * Knockback slides from all hits are accumulated per fighter, then assigned
 * once, so the order hits are applied in cannot matter.
 */
export function applyHits(s: MatchState, hits: [boolean, boolean], R: Rules): void {
  const slides: [Slide, Slide] = [
    { dist: 0, speed: 0 },
    { dist: 0, speed: 0 },
  ];
  const wall = R.match.wallEdge;
  const hpMax = R.fighter.hpMax;
  // Snapshot moves and block status before any hit lands: in a trade, applying
  // the first hit changes the other fighter's state.
  const mvs: [MoveRules, MoveRules] = [moveOf(s.f[0], R), moveOf(s.f[1], R)];
  const blocked: [boolean, boolean] = [false, false];
  for (let i = 0; i < 2; i++) {
    if (hits[i]) blocked[1 - i] = blocks(s.f[1 - i] as FighterState, mvs[i] as MoveRules);
  }

  for (let i = 0; i < 2; i++) {
    if (!hits[i]) continue;
    const a = s.f[i] as FighterState;
    const d = s.f[1 - i] as FighterState;
    const mv = mvs[i] as MoveRules;
    const dir = a.facing;
    const isBlocked = blocked[1 - i] as boolean;
    const stop = isBlocked ? mv.blockHitstop : mv.hitstop;

    let push = isBlocked ? mv.blockPush : mv.hitPush;
    if (isBlocked) {
      d.hp -= mulDiv(mv.damage, R.fighter.chipPct, 100);
      d.stun = mv.blockstun;
      enter(d, St.blockStun);
      a.heat += mv.heatBlock;
    } else {
      d.hp = s.sd ? 0 : d.hp - mv.damage;
      d.move = Mv.none;
      a.heat += mv.heatHit;
      if (mv.ringOut) d.roAble = 1;
      if (mv.launch) {
        enter(d, St.launched);
        d.grounded = 0;
        d.vx = dir * mv.launch[0];
        d.vy = mv.launch[1];
        d.stun = 0;
        push = [0, 1];
      } else {
        enter(d, St.hitStun);
        d.stun = mv.hitstun;
        d.vx = 0;
        if (!d.grounded) d.vy = 0;
      }
    }
    if (d.hp < 0) d.hp = 0;
    if (d.hp > hpMax) d.hp = hpMax;
    if (a.heat > R.heat.max) a.heat = R.heat.max;

    // Knockback slide; near the wall a non-ring-out push moves the attacker back instead.
    const [dist, ticks] = push;
    if (dist > 0) {
      const speed = idiv(dist, ticks);
      let own = dist;
      if (!d.roAble) {
        const target = Math.abs(d.x + dir * dist);
        const excess = target > wall ? target - Math.max(wall, Math.abs(d.x)) : 0;
        if (excess > 0) {
          own = dist - excess;
          const sa = slides[i] as Slide;
          sa.dist -= dir * excess;
          sa.speed = Math.max(sa.speed, speed);
        }
      }
      const sd = slides[1 - i] as Slide;
      sd.dist += dir * own;
      sd.speed = Math.max(sd.speed, speed);
    }

    a.hitDone = 1;
    a.hitstop = Math.max(a.hitstop, stop);
    d.hitstop = Math.max(d.hitstop, stop);
    d.hitT = s.tick;
    d.hitMv = mv.id;
    d.hitKind = isBlocked ? HitKind.block : HitKind.hit;

    if (mv.id === Mv.dive_kick && !hits[1 - i]) {
      // Bounce off the target (not in a trade: getting hit wins over bouncing).
      enter(a, St.fall);
      a.move = Mv.none;
      a.vx = dir * mv.bounce[0];
      a.vy = mv.bounce[1];
    }
  }

  for (let i = 0; i < 2; i++) {
    const sl = slides[i] as Slide;
    if (sl.dist === 0) continue;
    const f = s.f[i] as FighterState;
    f.slideV = sgn(sl.dist) * sl.speed;
    f.slideRem = Math.abs(sl.dist);
  }
}

/** Ring-outs and KOs; ends the round when either happens. */
export function checkFinish(s: MatchState, R: Rules): void {
  const out: [boolean, boolean] = [false, false];
  const ko: [boolean, boolean] = [false, false];
  for (let i = 0; i < 2; i++) {
    const f = s.f[i] as FighterState;
    if (f.st === St.ringOut || f.st === St.ko) continue;
    if (f.roAble && Math.abs(f.x) > R.match.ringEdge) {
      enter(f, St.ringOut);
      f.grounded = 0;
      f.move = Mv.none;
      out[i] = true;
    } else if (f.hp <= 0) {
      enter(f, St.ko);
      f.move = Mv.none;
      ko[i] = true;
    }
  }
  const lost0 = out[0] || ko[0];
  const lost1 = out[1] || ko[1];
  if (!lost0 && !lost1) return;
  if (lost0 && lost1) {
    endRound(s, 2, Reason.doubleKo, R);
    return;
  }
  const loser = lost0 ? 0 : 1;
  const reason = s.sd ? Reason.suddenDeath : out[loser] ? Reason.ringout : Reason.ko;
  endRound(s, loser === 0 ? 1 : 0, reason, R);
}

/** Heat decays 1 per tick while fighting (not during hit-stop); a full meter latches. */
export function decayHeat(s: MatchState, R: Rules): void {
  const H = R.heat;
  for (const f of s.f) {
    if (f.heat <= 0 || f.hitstop > 0) continue;
    if (H.latchAtMax && f.heat >= H.max) continue;
    f.heat -= H.decayPerTick;
    if (f.heat < 0) f.heat = 0;
  }
}
