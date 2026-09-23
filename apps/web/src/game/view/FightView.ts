import {
  AmbientLight, CircleGeometry, Color, DirectionalLight, Fog, HemisphereLight, Mesh, MeshBasicMaterial, MeshStandardMaterial,
  PlaneGeometry, PMREMGenerator, Scene, type Texture, type WebGLRenderer,
} from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import type { FighterState, MatchState } from "@cockfight/sim";
import type { Tier } from "@cockfight/shared";
import { KoPulse } from "../fx/KoPulse";
import { Particles } from "../fx/Particles";
import { FightCamera } from "./camera/FightCamera";
import { ChickenView, type ChickenAsset } from "./chicken/ChickenView";

/** Arena contract: the procedural junkyard (and later Sammy's arena.glb) implement it. */
export interface ArenaView {
  readonly root: import("three").Object3D;
  /** Optional scene rendered once into a PMREM env map for chrome / gold reflections. */
  readonly envScene?: Scene;
  setHype(h: number): void;
  update(dt: number, t: number): void;
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
  private envTex: Texture | null = null;
  private readonly renderer: WebGLRenderer;
  private time = 0;
  private readonly shadows: Mesh[] = [];

  constructor(renderer: WebGLRenderer, asset: ChickenAsset, tiers: [Tier, Tier], seed: number) {
    this.renderer = renderer;
    this.camera = new FightCamera(renderer.domElement.clientWidth / Math.max(1, renderer.domElement.clientHeight), seed);
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

    this.setEnvironment(null);

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
    for (const m of this.placeholder) m.removeFromParent();
    this.arena = arena;
    this.scene.add(arena.root);
    this.setEnvironment(arena.envScene ?? null);
  }

  get arenaView(): ArenaView | null {
    return this.arena;
  }

  private setEnvironment(envScene: Scene | null): void {
    const pmrem = new PMREMGenerator(this.renderer);
    const src = envScene ?? new RoomEnvironment();
    const rt = pmrem.fromScene(src, 0.04);
    this.envTex?.dispose();
    this.envTex = rt.texture;
    this.scene.environment = rt.texture;
    this.scene.environmentIntensity = 0.6;
    pmrem.dispose();
  }

  setAspect(aspect: number): void {
    this.camera.setAspect(aspect);
  }

  /** Per sim tick. */
  tick(s: MatchState): void {
    this.chickens[0].tick(s.f[0]);
    this.chickens[1].tick(s.f[1]);
  }

  render(prev: MatchState, cur: MatchState, alpha: number, dt: number): void {
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
    this.renderer.render(this.scene, this.camera.camera);
    this.ko.apply(this.renderer);
  }

  dispose(): void {
    for (const c of this.chickens) c.dispose();
    this.particles.dispose();
    this.ko.dispose();
    this.arena?.dispose();
    this.envTex?.dispose();
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
