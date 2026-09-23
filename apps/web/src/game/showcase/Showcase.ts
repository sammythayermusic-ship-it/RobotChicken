/**
 * The landing-page showcase: two robot chickens squaring off in a neon pit.
 *
 * Framework-free. The instance creates and owns its <canvas> and WebGL
 * context, and `dispose()` releases everything and forces the context lost, so
 * a React StrictMode double mount simply builds a second instance on a fresh
 * canvas (a canvas whose context was force-lost stays lost; never reuse one).
 *
 * Unlike the fight view, the showcase runs its AnimationMixers on wall-clock
 * time (`mixer.update(dt)`): nothing here is gameplay, so there is no sim
 * state to derive poses from.
 *
 * Motion (WCAG 2.2.2): the hero is decorative and would otherwise animate
 * forever, so it can be paused (`setPaused`, wired to a button on the page),
 * and under `prefers-reduced-motion: reduce` it starts paused, with the camera
 * sway off even if the viewer presses play. Paused means no render loop at
 * all: one settled frame is drawn whenever the canvas would otherwise be out
 * of date (first load, resize, a preference change). The media query is
 * followed live.
 */
import {
  ACESFilmicToneMapping,
  AnimationClip,
  AnimationMixer,
  Box3,
  Color,
  Fog,
  Group,
  MathUtils,
  Mesh,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
  type Material,
  type Object3D,
  type SkinnedMesh,
} from "three";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";
import { loadGltf, type GLTF } from "../engine/assets";
import { installDebug, type ShowcaseDebug } from "../engine/debug";
import { disposeRenderer } from "../engine/disposeRenderer";
import { buildBoxChicken, type BoxChicken } from "./boxChicken";
import { BACKDROP, buildStage, type Stage } from "./stage";

export const SHOWCASE_MODEL_URL = "/models/chicken_placeholder.glb";

export interface ShowcaseMotion {
  /** Held still: no render loop, just a settled frame when the picture changes. */
  readonly paused: boolean;
  /** The viewer's `prefers-reduced-motion: reduce`, followed live. */
  readonly reducedMotion: boolean;
}

export interface ShowcaseOptions {
  modelUrl?: string;
  /** Device-pixel-ratio cap; the hero is decorative, so fill rate matters more than crispness. */
  maxPixelRatio?: number;
  /**
   * Called once the first frame is on screen, then whenever `paused` or
   * `reducedMotion` changes, so a pause/play control can mirror the state.
   * Never called after `dispose()`.
   */
  onMotionChange?: (motion: ShowcaseMotion) => void;
}

interface Status {
  ready: boolean;
  fallback: boolean;
  clips: string[];
  error: string | null;
  frames: number;
}

/** Materials left alone when recolouring the second chicken (read as eyes and beak on both). */
const KEEP_COLOUR = new Set(["cf_eye", "cf_beak"]);
const VFOV = 30;
const SWAY_DEG = 9;
const SWAY_PERIOD_S = 16;
const LOAD_TIMEOUT_MS = 20_000;

export class Showcase {
  readonly canvas: HTMLCanvasElement;
  private readonly host: HTMLElement;
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(VFOV, 1, 0.05, 200);
  private readonly mixers: AnimationMixer[] = [];
  private readonly bobbers: { chicken: BoxChicken; phase: number }[] = [];
  private readonly status: Status = { ready: false, fallback: false, clips: [], error: null, frames: 0 };
  private readonly io: IntersectionObserver;
  private readonly ro: ResizeObserver;
  private readonly uninstallDebug: () => void;
  private readonly motionQuery: MediaQueryList;
  private readonly onMotionChange: ((motion: ShowcaseMotion) => void) | undefined;
  private reducedMotion: boolean;
  /** The viewer's own pause/play choice; null follows prefers-reduced-motion. */
  private userPaused: boolean | null = null;
  /** The canvas does not show the current scene: nothing drawn yet, resized, or re-posed. */
  private stale = true;
  private stage: Stage | null = null;
  /** Chicken height in world units; the stage and camera scale with it. */
  private unit = 1;
  private readonly focus = new Vector3();
  private readonly frameSize = new Vector3(1, 1, 1);
  private camDist = 6;
  private hasChickens = false;
  private onScreen = true;
  private disposed = false;
  private raf = 0;
  private last = -1;
  private time = 0;

  constructor(host: HTMLElement, opts: ShowcaseOptions = {}) {
    this.host = host;
    this.canvas = document.createElement("canvas");
    this.canvas.style.display = "block";
    this.canvas.style.width = "100%";
    this.canvas.style.height = "100%";
    // An opaque WebGL canvas is black until its first frame; stay transparent
    // so the page's CSS poster shows while the model loads, then fade in.
    this.canvas.style.opacity = "0";
    this.canvas.style.transition = "opacity 400ms ease-out";
    host.appendChild(this.canvas);

    try {
      this.renderer = new WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: "high-performance" });
    } catch (err) {
      this.canvas.remove();
      throw err;
    }
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, opts.maxPixelRatio ?? 1.5));
    this.renderer.setClearColor(BACKDROP, 1);
    this.scene.background = new Color(BACKDROP);
    this.motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    this.reducedMotion = this.motionQuery.matches;
    this.onMotionChange = opts.onMotionChange;

    const status = this.status;
    const motion = () => this.motion;
    this.uninstallDebug = installDebug("showcase", {
      get ready() {
        return status.ready;
      },
      get fallback() {
        return status.fallback;
      },
      get clips() {
        return Object.freeze([...status.clips]);
      },
      get error() {
        return status.error;
      },
      get paused() {
        return motion().paused;
      },
      get reducedMotion() {
        return motion().reducedMotion;
      },
      get frames() {
        return status.frames;
      },
    } satisfies ShowcaseDebug);

    this.resize();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.io = new IntersectionObserver((entries) => {
      const e = entries[entries.length - 1];
      if (e) this.onScreen = e.isIntersecting;
      this.updateRunning();
    });
    this.io.observe(host);
    document.addEventListener("visibilitychange", this.updateRunning);
    this.motionQuery.addEventListener("change", this.onMotionQuery);

    void this.load(opts.modelUrl ?? SHOWCASE_MODEL_URL);
    this.updateRunning();
  }

  get paused(): boolean {
    return this.userPaused ?? this.reducedMotion;
  }

  get motion(): ShowcaseMotion {
    return { paused: this.paused, reducedMotion: this.reducedMotion };
  }

  /**
   * The page's pause/play control. The choice holds until the viewer changes
   * their reduced-motion preference, which then takes over again.
   */
  setPaused(paused: boolean): void {
    if (this.disposed) return;
    const was = this.paused;
    this.userPaused = paused;
    if (paused === was) return;
    this.updateRunning();
    this.emitMotion();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    document.removeEventListener("visibilitychange", this.updateRunning);
    this.motionQuery.removeEventListener("change", this.onMotionQuery);
    this.io.disconnect();
    this.ro.disconnect();
    for (const mixer of this.mixers) {
      mixer.stopAllAction();
      mixer.uncacheRoot(mixer.getRoot());
    }
    // Not just renderer.dispose(): see disposeRenderer for what three r186 keeps.
    disposeRenderer(this.renderer, this.scene);
    this.canvas.remove();
    this.uninstallDebug();
  }

  private async load(url: string): Promise<void> {
    let gltf: GLTF | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // A decoder that dies inside its worker (e.g. wasm blocked by an enforcing
      // CSP) never settles the load, so bound it rather than stay blank forever.
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no model after ${LOAD_TIMEOUT_MS / 1000} s`)), LOAD_TIMEOUT_MS);
      });
      gltf = await Promise.race([loadGltf(url, this.renderer), timeout]);
    } catch (err) {
      if (this.disposed) return;
      this.status.error = err instanceof Error ? err.message : String(err);
      // A warning, not an error: the page still works, and until the Blender
      // placeholder is committed a missing glb is an expected state.
      console.warn(`[showcase] ${url} unavailable (${this.status.error}); showing box chickens`);
    } finally {
      clearTimeout(timer);
    }
    if (this.disposed) return;
    if (gltf) this.addGltfChickens(gltf);
    else this.addBoxChickens();
    this.hasChickens = true;
    this.updateRunning();
  }

  private addGltfChickens(gltf: GLTF): void {
    this.status.clips = gltf.animations.map((c) => c.name);
    const idle = AnimationClip.findByName(gltf.animations, "idle");
    if (!idle) console.warn(`[showcase] no "idle" clip (have: ${this.status.clips.join(", ") || "none"}); holding the rest pose`);

    const pair = [0, 1].map((side) => {
      const root = cloneSkinned(gltf.scene);
      root.traverse((o) => {
        // Skinned bounds are the bind pose; animation can leave them, so never cull.
        if ((o as SkinnedMesh).isSkinnedMesh) o.frustumCulled = false;
        if (o.name === "hurt_body" || o.name === "hit_beak") o.visible = false;
      });
      // The source materials are shared with the glTF cache: clone before tinting.
      if (side === 1) recolour(root, true);
      if (idle) {
        const mixer = new AnimationMixer(root);
        const action = mixer.clipAction(idle);
        action.play();
        // Half a cycle apart so the two do not breathe in lockstep.
        action.time = side * idle.duration * 0.5;
        this.mixers.push(mixer);
      }
      return root;
    });
    this.place(pair[0] as Object3D, pair[1] as Object3D);
  }

  private addBoxChickens(): void {
    this.status.fallback = true;
    const a = buildBoxChicken();
    const b = buildBoxChicken();
    recolour(b.root, false);
    this.bobbers.push({ chicken: a, phase: 0 }, { chicken: b, phase: Math.PI * 0.7 });
    this.place(a.root, b.root);
  }

  /** Stands the pair facing each other across the pit and frames the camera on them. */
  private place(left: Object3D, right: Object3D): void {
    // Skinned bounds are computed from bone world matrices, so settle them first.
    left.updateMatrixWorld(true);
    const size = new Box3().setFromObject(left).getSize(new Vector3());
    this.unit = MathUtils.clamp(size.y, 0.1, 100);
    const u = this.unit;
    // Model +Z is forward; +pi/2 about Y turns it toward +X.
    const gap = Math.max(size.z, size.x) * 0.5 + 0.3 * u;
    left.position.x = -gap;
    left.rotation.y = Math.PI / 2;
    right.position.x = gap;
    right.rotation.y = -Math.PI / 2;
    const pair = new Group();
    pair.name = "chickens";
    pair.add(left, right);
    this.scene.add(pair);

    this.stage = buildStage(u);
    this.scene.add(this.stage.group);

    pair.updateMatrixWorld(true);
    const bounds = new Box3().setFromObject(pair);
    bounds.getSize(this.frameSize);
    bounds.getCenter(this.focus);
    this.frameCamera();
  }

  /** Distance that fits the pair's bounds (plus margin) in both FOVs at the current aspect. */
  private frameCamera(): void {
    const aspect = this.camera.aspect;
    const vHalf = MathUtils.degToRad(VFOV) / 2;
    const hHalf = Math.atan(Math.tan(vHalf) * aspect);
    const w = this.frameSize.x * 1.35 + 0.6 * this.unit;
    const h = this.frameSize.y * 1.5;
    const dist = Math.max(h / 2 / Math.tan(vHalf), w / 2 / Math.tan(hHalf)) + this.frameSize.z * 0.5;
    this.camDist = dist;
    this.camera.far = dist * 20;
    this.camera.updateProjectionMatrix();
    // Near the pair stays clear; the wrecks behind melt into the backdrop.
    const fog = (this.scene.fog ??= new Fog(BACKDROP)) as Fog;
    fog.near = dist * 0.95;
    fog.far = dist * 2.8;
    this.poseCamera(this.time);
  }

  private poseCamera(t: number): void {
    const dist = this.camDist;
    const amp = this.reducedMotion ? 0 : MathUtils.degToRad(SWAY_DEG);
    const yaw = amp * Math.sin((t * 2 * Math.PI) / SWAY_PERIOD_S);
    const lift = this.unit * (0.32 + (this.reducedMotion ? 0 : 0.05 * Math.sin((t * 2 * Math.PI) / (SWAY_PERIOD_S * 0.6))));
    const target = this.focus;
    this.camera.position.set(target.x + Math.sin(yaw) * dist, target.y + lift, target.z + Math.cos(yaw) * dist);
    this.camera.lookAt(target.x, target.y - this.unit * 0.05, target.z);
  }

  private resize(): void {
    if (this.disposed) return;
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    // Setting the canvas size, even to the same value, blanks the drawing buffer.
    this.renderer.setSize(w, h, false);
    this.stale = true;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.hasChickens) this.frameCamera();
    this.updateRunning();
  }

  private readonly onMotionQuery = (e: MediaQueryListEvent): void => {
    if (this.disposed) return;
    this.reducedMotion = e.matches;
    // The newest word from the viewer replaces an earlier click on the control.
    this.userPaused = null;
    // The camera sway depends on it, so a still frame must be re-posed too.
    this.stale = true;
    this.updateRunning();
    this.emitMotion();
  };

  private emitMotion(): void {
    if (this.status.ready && !this.disposed) this.onMotionChange?.(this.motion);
  }

  /**
   * Nothing is drawn while off screen or in a hidden tab. Otherwise the render
   * loop runs unless paused; paused, one settled frame is drawn, and only when
   * the canvas is stale.
   */
  private readonly updateRunning = (): void => {
    const visible = !this.disposed && this.hasChickens && this.onScreen && !document.hidden;
    const loop = visible && !this.paused;
    if (loop && !this.raf) {
      this.last = -1;
      this.raf = requestAnimationFrame(this.frame);
    } else if (!loop && this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    if (visible && !loop && this.stale) this.render(0);
  };

  private readonly frame = (now: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    // Clamp so a long stall (breakpoint, throttled tab) does not jump the idle.
    const dt = this.last < 0 ? 0 : Math.min((now - this.last) / 1000, 0.1);
    this.last = now;
    this.render(dt);
  };

  /** Advances the scene `dt` seconds (0 re-poses it where it stands) and draws it. */
  private render(dt: number): void {
    this.time += dt;
    const t = this.time;

    for (const mixer of this.mixers) mixer.update(dt);
    for (const { chicken, phase } of this.bobbers) {
      chicken.root.position.y = 0.025 * this.unit * Math.abs(Math.sin(t * 2.4 + phase));
      chicken.head.rotation.x = 0.12 * Math.sin(t * 2.4 + phase);
    }
    this.stage?.update(t);
    this.poseCamera(t);
    this.renderer.render(this.scene, this.camera);
    this.status.frames++;
    this.stale = false;
    if (!this.status.ready) {
      this.status.ready = true;
      this.canvas.style.opacity = "1";
      this.emitMotion();
    }
  }
}

/**
 * Hue-rotates every material except eyes and beak so the second chicken reads
 * as a different fighter (a rust mirror match is unreadable). `clone` must be
 * true when the materials are shared with another object or a cache. Each
 * material is tinted exactly once however many meshes share it (rotating a
 * shared material per mesh would spin it back round to where it started).
 */
function recolour(root: Object3D, clone: boolean): void {
  const done = new Map<Material, Material>();
  const tint = (m: Material): Material => {
    if (KEEP_COLOUR.has(m.name)) return m;
    let out = done.get(m);
    if (!out) {
      out = clone ? m.clone() : m;
      const c = (out as Material & { color?: Color }).color;
      if (c?.isColor) c.offsetHSL(0.5, 0, 0);
      done.set(m, out);
    }
    return out;
  };
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(tint) : tint(mesh.material);
  });
}
