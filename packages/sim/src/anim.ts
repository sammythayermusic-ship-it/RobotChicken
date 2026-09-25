/**
 * Which clip and which sample a fighter is showing this tick. Shared by the
 * sim (hurtbox / hitbox lookup) and the renderer (pose), so visuals and
 * collision can never drift apart.
 */
import { idiv } from "./fixed";
import { Clip, type ClipRules, type MoveRules, type Rules } from "./rules";
import { Mv, St, type FighterState } from "./types";

/** Clip id for the fighter's current state. */
export function clipFor(f: FighterState, R: Rules): number {
  switch (f.st) {
    case St.idle:
      return Clip.idle;
    case St.walkF:
      return Clip.walk_fwd;
    case St.walkB:
      return Clip.walk_back;
    case St.dashF:
    case St.dashB:
      return Clip.dash;
    case St.jump:
      return Clip.jump;
    case St.fall:
    case St.ringOut:
      return Clip.fall;
    case St.land:
      return Clip.land;
    case St.block:
      return Clip.block;
    case St.blockStun:
      return Clip.block_hit;
    case St.attack:
      return (R.moves[f.move] as MoveRules).clip;
    case St.hitStun:
      return f.hitMv === Mv.slam || f.hitMv === Mv.super ? Clip.hit_heavy : Clip.hit_light;
    case St.launched:
      return Clip.hit_heavy;
    case St.knockdown:
      return Clip.knockdown;
    case St.getup:
      return Clip.getup;
    case St.ko:
      return f.grounded ? Clip.ko : Clip.hit_heavy;
    case St.win:
      return Clip.win;
    default:
      return Clip.idle;
  }
}

/**
 * Map a move frame (1-based) to a clip sample. Sample 0 is the pose before the
 * first tick. When the clip's authored phases equal the move's frame data the
 * mapping is the identity; otherwise each phase is remapped linearly, so moves
 * can be retimed in moves.json without re-exporting the clip.
 */
export function clipSample(clip: ClipRules, mv: MoveRules, frame: number): number {
  const n = clip.frames;
  const f = frame < 0 ? 0 : frame;
  const S = mv.startup;
  const A = mv.active;
  const ph = clip.phases;
  let out: number;
  if (!ph || (ph[0] === S && ph[1] === A && ph[2] === mv.recovery)) {
    out = f;
  } else if (f <= S) {
    out = idiv(f * ph[0], S);
  } else if (f <= S + A) {
    // A variable-length active window (dive kick) holds the last active pose.
    out = mv.id === Mv.dive_kick ? ph[0] + Math.min(f - S, ph[1]) : ph[0] + idiv((f - S) * ph[1], A);
  } else {
    out = ph[0] + ph[1] + idiv((f - S - A) * ph[2], mv.recovery);
  }
  return out > n ? n : out;
}

/** Sample index for the fighter's current clip. */
export function sampleFor(f: FighterState, clip: ClipRules, R: Rules): number {
  const n = clip.frames;
  if (f.st === St.attack) return clipSample(clip, R.moves[f.move] as MoveRules, f.stTick);
  if (f.st === St.hitStun || f.st === St.blockStun) {
    // Stretch the reaction over the whole stun, however long the move made it.
    const total = f.stTick + f.stun;
    return total > 0 ? Math.min(n, idiv(f.stTick * n, total)) : n;
  }
  if (clip.loop) return n > 0 ? f.stTick % n : 0;
  return f.stTick > n ? n : f.stTick;
}
