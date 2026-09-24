import { PerspectiveCamera } from "three";
import { RULES } from "@cockfight/sim";
import { hudFraction } from "./hudBand";
import { noise1 } from "./noise";

/** Units are game units (sim mu / 1000). The fight plane is z = 0. */
export const VFOV = 30;
const DT = 1 / 60;
/** Ring-out edge (moves.json `ringEdge`, 10 u). */
const RING = RULES.match.ringEdge / 1000;
/** Walk limit (moves.json `wallEdge`, 9.5 u): the farthest apart two standing roots get. */
const WALL = RULES.match.wallEdge / 1000;
/**
 * How far a fighter's mesh reaches from its root: the placeholder chicken's
 * tail is 0.75 behind, its beak 0.58 ahead, it is 1.48 tall and 0.97 deep;
 * the rest is headroom for poses.
 */
export const BODY = { half: 0.9, top: 1.65, depth: 0.5 } as const;
/** Room for the trauma shake and the per-hit kick, which both move the camera sideways. */
const SHAKE_PAD = 0.35;
const MIN_W = 9;
/**
 * Upright and square screens compose tighter: the width sets the scale there,
 * and the landscape margins would leave the chickens a few dozen pixels tall
 * on a phone (the upright touch layout gives the fight an about square area).
 * The margin eases from the tight to the wide values between these aspects,
 * so a pixel of height never jumps the framing. The hard fit still keeps
 * both bodies in frame.
 */
const MIN_W_TIGHT = 6.5;
const MARGIN = 7;
const MARGIN_TIGHT = 4;
const TIGHT_UNTIL = 0.95;
const WIDE_FROM = 1.3;
/** Both fighters at the walk limits, bodies and shake room included. */
const MAX_W = 2 * (WALL + BODY.half + SHAKE_PAD);
const MIN_D = 8;
/** Sanity cap only; a real portrait phone (aspect 0.45) needs ~93. */
const MAX_D = 400;
/** Look height for grounded fighters. A slight downward look makes the pit floor read (2.5D). */
const LOOK_Y = 1.5;
/** The camera sits this far above its look target, plus 4% of its distance. */
const RISE = 0.8;
const RISE_PER_D = 0.04;
/** Safety limits in NDC: the frame's sides and bottom; the top is the HUD band. */
const EDGE_X = 0.96;
const EDGE_BOTTOM = -0.94;
const TOP_PAD = 0.04;
/** A bottom inset (on-screen buttons) never squeezes the usable frame below this NDC height. */
const MIN_SPAN = 0.6;

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const damp = (a: number, b: number, k: number, dt: number) => a + (b - a) * (1 - Math.exp(-k * dt));
const tanHalf = (vfov: number) => Math.tan((vfov * Math.PI) / 360);
const rise = (d: number) => RISE + RISE_PER_D * d;

export interface ShakeSettings {
  /** 0..1 multiplier (accessibility setting; prefers-reduced-motion defaults to 0.3). Scales shake, kick, punch zoom and the super's FOV kick. */
  amount: number;
}

/** A camera placement: camera (and look target) x, distance from the fight plane, look height. */
export interface Framing {
  x: number;
  d: number;
  lookY: number;
}

/** Fighter roots in units (y is height above the pit floor). */
export interface Fighters {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * Height above the look target (u = y - lookY) of a point on the near face of
 * a body (z = BODY.depth) that projects exactly to NDC y = `lim`, for a camera
 * at distance d looking down with this rig's pitch. Exact for the pinhole
 * model: y_view = (d*u - a*p) / L and depth = (L^2 - a*u - d*p) / L, with
 * a = rise(d), L^2 = d^2 + a^2, p = BODY.depth.
 */
function uAt(d: number, lim: number, t: number): number {
  const a = rise(d);
  const p = BODY.depth;
  return (lim * t * (d * d + a * a - d * p) + a * p) / (d + lim * t * a);
}

interface Extent {
  /** Half-width needed either side of the camera x (bodies and shake room included). */
  hx: number;
  /** Highest point of either body. */
  yTop: number;
  /** Lowest point to keep in view (the feet on the pit floor). */
  yBot: number;
}

function extent(camX: number, f: Fighters): Extent {
  // A fighter past the ring edge is falling out of the pit (a ring-out): frame the edge, not the fall.
  const a = clamp(f.x1, -RING, RING);
  const b = clamp(f.x2, -RING, RING);
  return {
    hx: Math.max(Math.abs(a - camX), Math.abs(b - camX)) + BODY.half + SHAKE_PAD,
    yTop: Math.max(0, f.y1, f.y2) + BODY.top,
    yBot: 0,
  };
}

/**
 * Fixed side-view fight camera. Its state advances in fixed ticks (tick()),
 * so it is deterministic from the event stream; render() interpolates.
 *
 * Each tick it eases toward a composed shot (3.5 u of pit either side of the
 * pair, easing to 2 u on upright and square screens; look height 1.5), then applies hard limits so gameplay framing never
 * crops a fighter at any aspect, landscape or portrait, and never tucks a
 * jumping fighter under the HUD band: the camera pulls back as far as the
 * bodies need, and cranes up (or pulls back further) to fit a full jump. The
 * KO push-in is the one deliberate crop.
 */
export class FightCamera {
  readonly camera: PerspectiveCamera;
  readonly shake: ShakeSettings = { amount: 1 };
  private hudFrac = 0.14;
  private botFrac = 0;
  private cur: Framing & { ko: number } = { x: 0, d: 18, lookY: LOOK_Y, ko: 0 };
  private prev: Framing & { ko: number } = { x: 0, d: 18, lookY: LOOK_Y, ko: 0 };
  private readonly fighters: Fighters = { x1: -2.5, y1: 0, x2: 2.5, y2: 0 };
  private punch = 0;
  private trauma = 0;
  private kick = 0;
  private fovKick = 0;
  private koPush = 0;
  private koX = 0;
  private tickN = 0;
  private readonly seed: number;

  constructor(aspect: number, seed = 1) {
    this.camera = new PerspectiveCamera(VFOV, aspect, 0.1, 200);
    this.seed = seed >>> 0;
  }

  /**
   * New viewport shape. `hudFrac` is the share of the height the HUD band
   * covers (hudFraction(); unchanged when omitted), `botFrac` the share at
   * the bottom the fighters' feet stay above (on-screen buttons; unchanged
   * when omitted). Refits at once, so a resize never shows a cropped frame,
   * even while paused.
   */
  setAspect(aspect: number, hudFrac?: number, botFrac?: number): void {
    this.camera.aspect = aspect;
    if (hudFrac !== undefined) this.hudFrac = clamp(hudFrac, 0, 0.4);
    if (botFrac !== undefined) this.botFrac = clamp(botFrac, 0, 0.3);
    this.camera.updateProjectionMatrix();
    const vfov = this.fitFov();
    this.enforce(this.cur, vfov);
    this.enforce(this.prev, vfov);
  }

  /**
   * setAspect from a viewport size in CSS px (the HUD band is a fixed pixel
   * height). `bottomPx`: how much of the bottom to keep the feet above.
   */
  setViewport(widthPx: number, heightPx: number, bottomPx = 0): void {
    const h = Math.max(1, heightPx);
    this.setAspect(widthPx / h, hudFraction(widthPx, heightPx), bottomPx / h);
  }

  /** The bottom share in use (0 without on-screen buttons over the canvas). */
  get bottomFrac(): number {
    return this.botFrac;
  }

  /** Top of the usable frame (NDC y) under a HUD band covering `hudFrac` of the height. */
  static topLimit(hudFrac: number): number {
    return 1 - 2 * hudFrac - TOP_PAD;
  }

  /**
   * Bottom of the usable frame (NDC y) with `botFrac` of the height kept
   * clear, but never so high that less than MIN_SPAN is left under the HUD
   * band: a short screen gives up the inset before it gives up the fighters.
   */
  static bottomLimit(hudFrac: number, botFrac = 0): number {
    const room = Math.max(0, (FightCamera.topLimit(hudFrac) - EDGE_BOTTOM - MIN_SPAN) / 2);
    return EDGE_BOTTOM + 2 * clamp(botFrac, 0, room);
  }

  /** Visible width (units) the composition wants at the fight plane for fighters at x1, x2 (tighter on upright and square screens). */
  static wantWidth(x1: number, x2: number, aspect = 16 / 9): number {
    const t = clamp((aspect - TIGHT_UNTIL) / (WIDE_FROM - TIGHT_UNTIL), 0, 1);
    const margin = MARGIN_TIGHT + (MARGIN - MARGIN_TIGHT) * t;
    const minW = MIN_W_TIGHT + (MIN_W - MIN_W_TIGHT) * t;
    return clamp(Math.abs(x1 - x2) + margin, minW, MAX_W);
  }

  /** Distance that shows `width` units horizontally at this aspect (at the fight plane, pitch ignored). */
  static distanceFor(width: number, aspect: number, vfov = VFOV): number {
    return width / 2 / (tanHalf(vfov) * aspect);
  }

  /**
   * Smallest distance at which, for a camera at `camX`, both bodies fit
   * between the frame's sides and the span from the feet to the top of the
   * highest body fits between the bottom edge and the HUD band.
   */
  static fitDistance(camX: number, f: Fighters, aspect: number, hudFrac: number, vfov = VFOV, botFrac = 0): number {
    const { hx, yTop, yBot } = extent(camX, f);
    const t = tanHalf(vfov);
    const top = FightCamera.topLimit(hudFrac);
    const bot = FightCamera.bottomLimit(hudFrac, botFrac);
    const hNeed = hx / (EDGE_X * t * aspect);
    const vNeed = yTop - yBot;
    const vSlope = (top - bot) * t;
    // Start from the flat (no pitch, no depth) answer, then correct: both "have" terms grow ~linearly in d.
    let d = Math.max(MIN_D, hNeed + BODY.depth, vNeed / vSlope);
    for (let i = 0; i < 8; i++) {
      const a = rise(d);
      const L2 = d * d + a * a;
      const uTop = uAt(d, top, t);
      // Depth of the frame's side edge at the height of the HUD line (the worst case for width).
      const hHave = (L2 - a * uTop - d * BODY.depth) / Math.sqrt(L2);
      const vHave = uTop - uAt(d, bot, t);
      const step = Math.max(hNeed - hHave, (vNeed - vHave) / vSlope);
      if (step <= 1e-7) break;
      d += step;
    }
    return Math.min(MAX_D, d + 1e-4);
  }

  /** Look heights at distance d that keep [yBot, yTop] between the bottom limit and the HUD band. */
  static lookRange(d: number, f: Fighters, hudFrac: number, vfov = VFOV, botFrac = 0): [lo: number, hi: number] {
    const { yTop, yBot } = extent(0, f);
    const t = tanHalf(vfov);
    return [yTop - uAt(d, FightCamera.topLimit(hudFrac), t), yBot - uAt(d, FightCamera.bottomLimit(hudFrac, botFrac), t)];
  }

  /**
   * The shot the camera eases toward: the composition (pair centred, 3.5 u of
   * pit each side, down to 2 u upright, the centre clamped so the view stops 1.5 u past the ring
   * edges), pulled back and craned up only as far as the fit needs. `zoomIn`
   * (the hit punch) eats into the composition's margin, never into the fit.
   * `vfov` is the lens actually in use (the super narrows it).
   */
  static frame(f: Fighters, aspect: number, hudFrac: number, zoomIn = 0, vfov = VFOV, botFrac = 0): Framing {
    const a = clamp(f.x1, -RING, RING);
    const b = clamp(f.x2, -RING, RING);
    const w = FightCamera.wantWidth(a, b, aspect);
    const maxX = Math.max(0, RING + 1.5 - w / 2);
    const x = clamp((a + b) / 2, -maxX, maxX);
    const d = Math.max(FightCamera.fitDistance(x, f, aspect, hudFrac, vfov, botFrac), FightCamera.distanceFor(w, aspect) - zoomIn);
    const [lo, hi] = FightCamera.lookRange(d, f, hudFrac, vfov, botFrac);
    return { x, d, lookY: Math.min(Math.max(LOOK_Y, lo), hi) };
  }

  onHit(damage: number, dir: number): void {
    this.punch = Math.min(this.punch + 0.04 * damage, 1.2);
    this.kick += dir * Math.min(0.25, 0.01 * damage);
  }

  addTrauma(t: number): void {
    this.trauma = Math.min(1, this.trauma + t);
  }

  onSuper(): void {
    this.fovKick = -3;
  }

  onKo(loserX: number): void {
    this.koPush = 1;
    this.koX = loserX;
  }

  reset(): void {
    this.trauma = 0;
    this.punch = 0;
    this.kick = 0;
    this.fovKick = 0;
    this.koPush = 0;
  }

  /** The lens in use this tick (the super's FOV kick narrows it). */
  private fitFov(): number {
    return VFOV + this.fovKick * this.shake.amount;
  }

  /** Hard limits on a (damped) state: pull back until both bodies fit, then keep the look height in range. */
  private enforce(s: Framing, vfov: number): void {
    const aspect = this.camera.aspect;
    s.d = Math.max(s.d, FightCamera.fitDistance(s.x, this.fighters, aspect, this.hudFrac, vfov, this.botFrac));
    const [lo, hi] = FightCamera.lookRange(s.d, this.fighters, this.hudFrac, vfov, this.botFrac);
    s.lookY = Math.min(Math.max(s.lookY, lo), hi);
  }

  /** Advance one sim tick. Root positions in units (y = height above the floor). */
  tick(x1: number, x2: number, y1 = 0, y2 = 0): void {
    this.tickN++;
    Object.assign(this.prev, this.cur);
    const f = this.fighters;
    f.x1 = x1;
    f.x2 = x2;
    f.y1 = y1;
    f.y2 = y2;
    const amount = this.shake.amount;
    const vfov = this.fitFov();
    const want = FightCamera.frame(f, this.camera.aspect, this.hudFrac, this.punch * amount, vfov, this.botFrac);
    const c = this.cur;
    c.x = damp(c.x, want.x, 6, DT);
    c.d = damp(c.d, want.d, 4, DT);
    c.lookY = damp(c.lookY, want.lookY, 6, DT);
    c.ko = damp(c.ko, this.koPush, 4, DT);
    this.enforce(c, vfov);
    this.punch = damp(this.punch, 0, 10, DT);
    this.kick = damp(this.kick, 0, 14, DT);
    this.fovKick = damp(this.fovKick, 0, 5, DT);
    this.koPush = Math.max(0, this.koPush - DT / 1.2);
    this.trauma = Math.max(0, this.trauma - 1.6 * DT);
  }

  /** Shake offsets for the current tick (exposed for tests). Everything scales with the shake setting. */
  shakeOffsets(alpha = 0): { x: number; y: number; roll: number } {
    const amount = this.shake.amount;
    const s = this.trauma * this.trauma * amount;
    const t = (this.tickN + alpha) * (25 / 60);
    return {
      x: 0.25 * s * noise1(this.seed, t) + this.kick * amount,
      y: 0.18 * s * noise1(this.seed + 17, t),
      roll: ((1.5 * Math.PI) / 180) * s * noise1(this.seed + 31, t),
    };
  }

  /** The eased shot for the current tick, before the KO push-in and shake (tests, debugging). */
  get framing(): Readonly<Framing> {
    return this.cur;
  }

  render(alpha: number): void {
    const p = this.prev;
    const c = this.cur;
    const lerp = (a: number, b: number) => a + (b - a) * alpha;
    const ko = lerp(p.ko, c.ko);
    let x = lerp(p.x, c.x);
    x += (this.koX - x) * 0.5 * ko;
    const d = Math.max(MIN_D, lerp(p.d, c.d) - 4 * ko);
    const lookY = lerp(p.lookY, c.lookY);
    const sh = this.shakeOffsets(alpha);
    const cam = this.camera;
    cam.fov = VFOV + this.fovKick * this.shake.amount;
    // Portrait pulls the camera far back; keep the whole pit inside the far plane.
    cam.far = Math.max(200, d + 130);
    cam.position.set(x + sh.x, lookY + rise(d) + sh.y, d);
    cam.lookAt(x + sh.x * 0.5, lookY + sh.y * 0.5, 0);
    cam.rotation.z += sh.roll;
    cam.updateProjectionMatrix();
  }

  get traumaLevel(): number {
    return this.trauma;
  }
}
