import { PerspectiveCamera } from "three";
import { noise1 } from "./noise";

/** Units are game units (sim mu / 1000). The fight plane is z = 0. */
export const VFOV = 30;
const DT = 1 / 60;
const RING = 10;
const MIN_W = 9;
const MAX_W = 20;
// A slight downward look makes the pit floor read (2.5D) without losing the side view.
const CAM_Y = 2.3;
const LOOK_Y = 1.5;

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const damp = (a: number, b: number, k: number, dt: number) => a + (b - a) * (1 - Math.exp(-k * dt));

export interface ShakeSettings {
  /** 0..1 multiplier (accessibility setting; prefers-reduced-motion defaults to 0.3). */
  amount: number;
}

/**
 * Fixed side-view fight camera. Its state advances in fixed ticks (tick()),
 * so it is deterministic from the event stream; render() interpolates.
 * Framing is computed from the HORIZONTAL fov so narrow (portrait-ish)
 * aspects still keep both fighters in frame.
 */
export class FightCamera {
  readonly camera: PerspectiveCamera;
  readonly shake: ShakeSettings = { amount: 1 };
  private x = 0;
  private d = 18;
  private punch = 0;
  private trauma = 0;
  private kick = 0;
  private fovKick = 0;
  private koPush = 0;
  private koX = 0;
  private tickN = 0;
  private px = 0;
  private pd = 18;
  private readonly seed: number;

  constructor(aspect: number, seed = 1) {
    this.camera = new PerspectiveCamera(VFOV, aspect, 0.1, 200);
    this.seed = seed >>> 0;
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Visible width (units) wanted at the fight plane for fighters at x1, x2. */
  static wantWidth(x1: number, x2: number): number {
    return clamp(Math.abs(x1 - x2) + 7, MIN_W, MAX_W);
  }

  /** Distance that shows `width` units horizontally at this aspect. */
  static distanceFor(width: number, aspect: number): number {
    const hfov = 2 * Math.atan(Math.tan(((VFOV * Math.PI) / 180) / 2) * aspect);
    return width / 2 / Math.tan(hfov / 2);
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

  /** Advance one sim tick. Positions in units. */
  tick(x1: number, x2: number): void {
    this.tickN++;
    this.px = this.x;
    this.pd = this.d;
    const aspect = this.camera.aspect;
    const w = FightCamera.wantWidth(x1, x2);
    const mid = (x1 + x2) / 2;
    const maxX = Math.max(0, RING + 1.5 - w / 2);
    const koBlend = this.koPush;
    const targetX = clamp(mid, -maxX, maxX) * (1 - koBlend * 0.5) + this.koX * koBlend * 0.5;
    const dist = clamp(FightCamera.distanceFor(w, aspect) - this.punch - koBlend * 4, 8, 60);
    this.x = damp(this.x, targetX, 6, DT);
    this.d = damp(this.d, dist, 4, DT);
    this.punch = damp(this.punch, 0, 10, DT);
    this.kick = damp(this.kick, 0, 14, DT);
    this.fovKick = damp(this.fovKick, 0, 5, DT);
    this.koPush = Math.max(0, this.koPush - DT / 1.2);
    this.trauma = Math.max(0, this.trauma - 1.6 * DT);
  }

  /** Shake offsets for the current tick (exposed for tests). */
  shakeOffsets(alpha = 0): { x: number; y: number; roll: number } {
    const s = this.trauma * this.trauma * this.shake.amount;
    const t = (this.tickN + alpha) * (25 / 60);
    return {
      x: 0.25 * s * noise1(this.seed, t) + this.kick,
      y: 0.18 * s * noise1(this.seed + 17, t),
      roll: ((1.5 * Math.PI) / 180) * s * noise1(this.seed + 31, t),
    };
  }

  render(alpha: number): void {
    const x = this.px + (this.x - this.px) * alpha;
    const d = this.pd + (this.d - this.pd) * alpha;
    const sh = this.shakeOffsets(alpha);
    const cam = this.camera;
    cam.fov = VFOV + this.fovKick;
    cam.position.set(x + sh.x, CAM_Y + sh.y + d * 0.04, d);
    cam.lookAt(x + sh.x * 0.5, LOOK_Y + sh.y * 0.5, 0);
    cam.rotation.z += sh.roll;
    cam.updateProjectionMatrix();
  }

  get traumaLevel(): number {
    return this.trauma;
  }
}
