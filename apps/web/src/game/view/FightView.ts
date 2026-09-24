import {
  AmbientLight, CircleGeometry, Color, DirectionalLight, Fog, HemisphereLight, Mesh, MeshBasicMaterial, MeshStandardMaterial,
  PlaneGeometry, PMREMGenerator, Scene, type WebGLRenderer, type WebGLRenderTarget,
} from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import type { FighterState, MatchState } from "@cockfight/sim";
import type { Tier } from "@cockfight/shared";
import type { QualitySettings, QualityTier } from "../engine/quality";
import { KoPulse } from "../fx/KoPulse";
import { Particles } from "../fx/Particles";
import { FightCamera } from "./camera/FightCamera";
import { hudFraction, insetFraction } from "./camera/hudBand";
import { ChickenView, type ChickenAsset } from "./chicken/ChickenView";

/** Arena contract: the procedural junkyard (and later Sammy's arena.glb) implement it. */
export interface ArenaView {
  readonly root: import("three").Object3D;
  /** Optional scene rendered once into a PMREM env map for chrome / gold reflections. */
  readonly envScene?: Scene;
  setHype(h: number): void;
  update(dt: number, t: number): void;
  /** Scale the arena's own cost with the quality tier (optional: an arena may not have anything to drop). */
  setQuality?(tier: QualityTier): void;
  dispose(): void;
}

/**
 * The fight scene: arena, two chickens, particles, camera and the KO pass.
 * render() interpolates between the previous and current sim states.
 */
export class FightView {
  readonly scene = new Scene();
  readonly camera: FightCamera;
  readonly particles: Particles;
  readonly ko = new KoPulse();
  readonly chickens: [ChickenView, ChickenView];
  private arena: ArenaView | null = null;
  private readonly placeholder: Mesh[] = [];
  /** The PMREM target behind scene.environment (disposed whole: FBO, depth buffer and texture). */
  private envRT: WebGLRenderTarget | null = null;
  private tier: QualityTier = "high";
  private readonly renderer: WebGLRenderer;
  private time = 0;
  private readonly shadows: Mesh[] = [];
  private bottomPx = 0;

  constructor(renderer: WebGLRenderer, asset: ChickenAsset, tiers: [Tier, Tier], seed: number) {
    this.renderer = renderer;
    const el = renderer.domElement;
    this.camera = new FightCamera(el.clientWidth / Math.max(1, el.clientHeight), seed);
    const box = el.getBoundingClientRect();
    if (box.height > 0) this.camera.setViewport(box.width, box.height);
    this.scene.background = new Color(0x0b0a10);
    this.scene.fog = new Fog(0x0b0a10, 24, 70);

    // Lights: fighters are lit, the arena is (mostly) baked.
    this.scene.add(new HemisphereLight(0x8fa3c8, 0x2a1a12, 0.9));
    this.scene.add(new AmbientLight(0x221a18, 0.4));
    const key = new DirectionalLight(0xfff0dd, 2.2);
    key.position.set(4, 9, 7);
    this.scene.add(key);
    const rim = new DirectionalLight(0xff6a2a, 1.6);
    rim.position.set(-6, 4, -6);
    this.scene.add(rim);

    // Placeholder floor until the arena mounts.
    const floor = new Mesh(new PlaneGeometry(24, 12), new MeshStandardMaterial({ color: 0x2b2522, roughness: 0.95 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, 0, -2);
    this.placeholder.push(floor);
    this.scene.add(floor);
    // No env map yet: the arena brings its own (setArena); ensureEnvironment() falls back to a room.

    const same = tiers[0] === tiers[1];
    this.chickens = [
      new ChickenView(asset, tiers[0]),
      new ChickenView(asset, tiers[1], { hueShift: same ? 0.55 : 0 }),
    ];
    for (const c of this.chickens) {
      this.scene.add(c.root);
      const blob = new Mesh(
        new CircleGeometry(0.55, 24),
        new MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.45, depthWrite: false }),
      );
      blob.rotation.x = -Math.PI / 2;
      blob.renderOrder = 1;
      this.shadows.push(blob);
      this.scene.add(blob);
    }
    this.particles = new Particles(this.scene);
  }

  /** Mount an arena (replaces the placeholder floor) and rebuild the env map from it. */
  setArena(arena: ArenaView): void {
    this.arena?.dispose();
    for (const m of this.placeholder) {
      m.removeFromParent();
      m.geometry.dispose();
      (m.material as MeshStandardMaterial).dispose();
    }
    this.placeholder.length = 0;
    this.arena = arena;
    this.scene.add(arena.root);
    arena.setQuality?.(this.tier);
    this.setEnvironment(arena.envScene ?? null);
  }

  /**
   * Quality tier: the fx particles (low keeps only the hit flash) and the
   * arena's own cost. Remembered, so an arena mounted later starts at it.
   */
  setQuality(q: QualitySettings): void {
    this.tier = q.tier;
    this.particles.enabled = q.particles;
    this.arena?.setQuality?.(q.tier);
  }

  /**
   * Make sure the chickens have an env map to reflect: three's RoomEnvironment
   * when no arena supplied one (no arena, or it failed to build). Call before
   * compiling shaders, since the env map is part of the material programs.
   */
  ensureEnvironment(): void {
    if (!this.envRT) this.setEnvironment(null);
  }

  get arenaView(): ArenaView | null {
    return this.arena;
  }

  private setEnvironment(envScene: Scene | null): void {
    const pmrem = new PMREMGenerator(this.renderer);
    const room = envScene ? null : new RoomEnvironment();
    const rt = pmrem.fromScene(envScene ?? (room as RoomEnvironment), 0.04);
    room?.dispose(); // its meshes were uploaded by the bake; the map is all we keep
    pmrem.dispose();
    this.envRT?.dispose();
    this.envRT = rt;
    this.scene.environment = rt.texture;
    this.scene.environmentIntensity = 0.6;
  }

  /**
   * The canvas changed shape. The HUD band over the top of the canvas is a
   * fixed pixel height, so the camera also needs the canvas's CSS height.
   */
  setAspect(aspect: number): void {
    // The unrounded box: the HUD's container queries see 639.5 px as under 640, clientWidth says 640.
    const r = this.renderer.domElement.getBoundingClientRect();
    if (r.height > 0) this.camera.setAspect(aspect, hudFraction(r.width, r.height), this.insetFrac());
    else this.camera.setAspect(aspect);
  }

  /**
   * On-screen buttons over the bottom of the canvas (CSS px). The camera
   * keeps only a share of it clear (insetFraction): the buttons sit in the
   * corners, and a full inset would shrink the chickens on a short screen.
   */
  setBottomInset(px: number): void {
    this.bottomPx = Math.max(0, px);
    const el = this.renderer.domElement;
    if (el.clientHeight > 0) this.camera.setAspect(this.camera.camera.aspect, undefined, this.insetFrac());
  }

  private insetFrac(): number {
    return insetFraction(this.bottomPx, this.renderer.domElement.clientHeight);
  }

  /** Per sim tick. */
  tick(s: MatchState): void {
    this.chickens[0].tick(s.f[0]);
    this.chickens[1].tick(s.f[1]);
  }

  render(prev: MatchState, cur: MatchState, alpha: number, dt: number): void {
    this.ensureEnvironment(); // no-op once there is one
    this.time += dt;
    for (let i = 0; i < 2; i++) {
      const c = this.chickens[i] as ChickenView;
      c.render(prev.f[i] as FighterState, cur.f[i] as FighterState, alpha, cur.tick);
      const blob = this.shadows[i] as Mesh;
      const h = Math.max(0, c.root.position.y);
      blob.position.set(c.root.position.x, 0.01, 0);
      const k = 1 / (1 + h * 0.8);
      blob.scale.setScalar(k);
      (blob.material as MeshBasicMaterial).opacity = 0.45 * k * (Math.abs(c.root.position.x) > 10 ? 0 : 1);
    }
    this.arena?.update(dt, this.time);
    this.camera.render(alpha);
    // Fog starts past the fighters wherever the camera is (portrait pulls it far back).
    const fog = this.scene.fog as Fog;
    const d = this.camera.camera.position.z;
    fog.near = d + 8;
    fog.far = d + 55;
    this.renderer.render(this.scene, this.camera.camera);
    this.ko.apply(this.renderer);
  }

  dispose(): void {
    for (const c of this.chickens) c.dispose();
    this.particles.dispose();
    this.ko.dispose();
    this.arena?.dispose();
    this.envRT?.dispose();
    this.envRT = null;
    this.scene.traverse((o) => {
      if (o instanceof Mesh) {
        o.geometry.dispose();
        const m = o.material;
        if (Array.isArray(m)) m.forEach((x) => x.dispose());
        else m.dispose();
      }
    });
  }
}
