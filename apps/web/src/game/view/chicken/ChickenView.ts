import {
  AnimationMixer, Group, Mesh, MeshStandardMaterial, type AnimationAction, type AnimationClip, type Material, type Object3D,
} from "three";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";
import { CLIP_NAMES, HitKind, RULES, St, clipFor, sampleFor, type ClipRules, type FighterState, type Rules } from "@cockfight/sim";
import type { Tier } from "@cockfight/shared";
import { TIER_SLOTS, tierMaterials } from "./materials";

export interface ChickenAsset {
  scene: Object3D;
  animations: AnimationClip[];
}

const BLEND_TICKS = 4;
const TURN_TICKS = 5;
const FLASH_TICKS = 2;
const FPS = 60;

/**
 * One fighter on screen. Pose is a pure function of sim state: the view never
 * advances its own animation clock, so hit-stop freezes exactly and replays
 * look identical. Blends and turns are counted in sim ticks for the same reason.
 */
export class ChickenView {
  readonly root = new Group();
  private readonly model: Object3D;
  private readonly mixer: AnimationMixer;
  private readonly actions = new Map<number, AnimationAction>();
  private readonly flashMats: MeshStandardMaterial[] = [];
  private readonly R: Rules;
  private clip = -1;
  private prevClip = -1;
  private prevTime = 0;
  private blend = BLEND_TICKS;
  private yaw = Math.PI / 2;
  private yawFrom = Math.PI / 2;
  private yawT = TURN_TICKS;
  private facing = 1;
  private flash = 0;
  private lastHitT = -1;
  private ownedMaterials: Material[] = [];

  constructor(asset: ChickenAsset, tier: Tier, opts: { hueShift?: number; R?: Rules } = {}) {
    this.R = opts.R ?? RULES;
    this.model = cloneSkinned(asset.scene);
    this.root.add(this.model);
    this.mixer = new AnimationMixer(this.model);
    for (const clip of asset.animations) {
      const id = (CLIP_NAMES as readonly string[]).indexOf(clip.name);
      if (id < 0) continue;
      const action = this.mixer.clipAction(clip);
      action.play();
      action.setEffectiveWeight(0);
      this.actions.set(id, action);
    }
    this.setTier(tier, opts.hueShift ?? 0);
    this.model.traverse((o) => {
      o.frustumCulled = false; // skinned bounds don't follow the pose
    });
  }

  /** Swap the tier materials (cloned per fighter, so flashes don't leak). */
  setTier(tier: Tier, hueShift = 0): void {
    for (const m of this.ownedMaterials) m.dispose();
    const mats = tierMaterials(tier, hueShift);
    this.ownedMaterials = Object.values(mats);
    this.flashMats.length = 0;
    this.model.traverse((o) => {
      if (!(o instanceof Mesh)) return;
      const swap = (m: Material): Material => {
        const slot = (TIER_SLOTS as readonly string[]).includes(m.name) ? (mats as Record<string, Material>)[m.name] : null;
        const out = slot ?? m.clone();
        if (!slot) this.ownedMaterials.push(out);
        if (out instanceof MeshStandardMaterial) this.flashMats.push(out);
        return out;
      };
      o.material = Array.isArray(o.material) ? o.material.map(swap) : swap(o.material as Material);
    });
    for (const m of this.flashMats) m.userData.baseEmissive = m.emissive.clone();
  }

  get clipCount(): number {
    return this.actions.size;
  }

  /** Advance per-tick presentation state (blends, turns, flash). Call once per sim tick. */
  tick(f: FighterState): void {
    const clipId = clipFor(f, this.R);
    if (clipId !== this.clip) {
      if (this.clip >= 0) {
        this.prevClip = this.clip;
        this.prevTime = this.actions.get(this.clip)?.time ?? 0;
        this.blend = 0;
      }
      this.clip = clipId;
    } else if (this.blend < BLEND_TICKS && f.hitstop === 0) {
      this.blend++;
    }
    if (f.facing !== this.facing) {
      this.yawFrom = this.yaw;
      this.facing = f.facing;
      this.yawT = 0;
    } else if (this.yawT < TURN_TICKS) this.yawT++;
    if (f.hitT !== this.lastHitT) {
      this.lastHitT = f.hitT;
      if (f.hitKind === HitKind.hit) this.flash = FLASH_TICKS;
    } else if (this.flash > 0 && f.hitstop === 0) this.flash--;
  }

  /** Pose for rendering. `prev`/`cur` are consecutive sim states; alpha interpolates position. */
  render(prev: FighterState, cur: FighterState, alpha: number, tick: number): void {
    const frozen = cur.hitstop > 0;
    const a = frozen ? 1 : alpha;
    let x = (prev.x + (cur.x - prev.x) * a) / 1000;
    const y = (prev.y + (cur.y - prev.y) * a) / 1000;
    if (frozen && cur.hitKind === HitKind.hit && cur.st !== St.attack) x += (tick & 2 ? 0.04 : -0.04);
    this.root.position.set(x, y, 0);
    const targetYaw = this.facing > 0 ? Math.PI / 2 : -Math.PI / 2;
    const k = Math.min(1, this.yawT / TURN_TICKS);
    this.yaw = this.yawFrom + (targetYaw - this.yawFrom) * k;
    this.root.rotation.y = this.yaw;

    const clip = this.R.clips[this.clip] as ClipRules | undefined;
    const time = clip ? sampleFor(cur, clip, this.R) / FPS : 0;
    const w = this.prevClip >= 0 ? Math.min(1, this.blend / BLEND_TICKS) : 1;
    for (const [id, action] of this.actions) {
      if (id === this.clip) {
        action.time = time;
        action.setEffectiveWeight(w);
      } else if (id === this.prevClip && w < 1) {
        action.time = this.prevTime;
        action.setEffectiveWeight(1 - w);
      } else action.setEffectiveWeight(0);
    }
    this.mixer.update(0);

    // Hit flash: a hot orange-white tint for two ticks, strong enough to read
    // on every tier without blowing the chicken out to a flat white shape.
    const f = this.flash > 0;
    for (const m of this.flashMats) {
      const base = m.userData.baseEmissive as MeshStandardMaterial["emissive"] | undefined;
      if (f) m.emissive.setRGB(0.55, 0.38, 0.22);
      else if (base) m.emissive.copy(base);
    }
  }

  dispose(): void {
    this.mixer.stopAllAction();
    for (const m of this.ownedMaterials) m.dispose();
    this.root.removeFromParent();
  }
}
