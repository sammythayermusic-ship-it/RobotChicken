import { ACESFilmicToneMapping, SRGBColorSpace, WebGLRenderer } from "three";
import { B, RULES, stateHash, type CpuLevel, type MatchState, type SimEvent } from "@cockfight/sim";
import type { Tier } from "@cockfight/shared";
import type { AudioSink } from "../fx/director";
import { Director } from "../fx/director";
import type { HudStore } from "../hud/hudStore";
import { LocalMatch } from "../match/LocalMatch";
import { SOLO, VERSUS } from "../match/input/bindings";
import { KeyboardInput } from "../match/input/keyboard";
import { CpuSource, KeyboardSource, ScriptSource, type InputSource } from "../match/input/source";
import type { ArenaView } from "../view/FightView";
import { FightView } from "../view/FightView";
import { loadGltf } from "./assets";
import { FixedLoop, STEP_MS } from "./loop";
import { chickenModelUrl } from "./models";
import { PerfMeter, type PerfSnapshot } from "./perf";
import { qualitySettings, type QualityTier } from "./quality";

export { chickenModelUrl };
export type FightMode = "cpu" | "2p" | "demo";

export interface FightOptions {
  mode: FightMode;
  difficulty: CpuLevel;
  tiers: [Tier, Tier];
  matchId: string;
  hud: HudStore;
  quality: QualityTier;
  /** Sim advances only via __cockfight.fight.stepTicks (deterministic e2e). */
  manual?: boolean;
  /** Expose input-injection debug handles. */
  debug?: boolean;
  /** Build the procedural arena (loaded lazily); off for the fastest tests. */
  arena?: (renderer: WebGLRenderer) => Promise<ArenaView>;
  /** Bench mode: keep every frame time of the match (not a rolling window). */
  bench?: boolean;
  /** Attach an audio engine once the user has interacted. */
  audio?: () => Promise<AudioSink | null>;
  onMatchEnd?: (winner: number, replayHash: string) => void;
}

export interface FightEngine {
  readonly ready: Promise<void>;
  pause(): void;
  resume(): void;
  readonly paused: boolean;
  setQuality(tier: QualityTier): void;
  setShake(amount: number): void;
  setAudio(a: AudioSink | null): void;
  perf(): PerfSnapshot;
  /** Forget frame times so far (e.g. loading and shader warm-up). */
  resetPerf(): void;
  dispose(): void;
}


interface DebugFight {
  /** True once the model is loaded, shaders are compiled and the loop runs. */
  ready(): boolean;
  state(): MatchState;
  events(): SimEvent[];
  hash(): string;
  sounds(): readonly string[];
  fxLive(): boolean;
  perf(): PerfSnapshot;
  clips(): number;
  quality(): QualityTier;
  setInput?(player: 0 | 1, mask: number): void;
  stepTicks?(n: number): void;
  pause?(): void;
  resume?(): void;
  B: typeof B;
}

export function createFightEngine(host: HTMLElement, opts: FightOptions): FightEngine {
  const canvas = document.createElement("canvas");
  canvas.className = "block h-full w-full touch-none select-none outline-none";
  canvas.tabIndex = 0;
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  host.appendChild(canvas);

  const renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.info.autoReset = false;
  let quality = qualitySettings(opts.quality, window.devicePixelRatio || 1);
  const perf = new PerfMeter(opts.bench ? 60 * 60 * 15 : 240);

  const resize = () => {
    const w = Math.max(1, host.clientWidth);
    const h = Math.max(1, host.clientHeight);
    renderer.setPixelRatio(quality.dprCap);
    renderer.setSize(w, h, false);
    view?.setAspect(w / h);
  };

  const kb = new KeyboardInput(opts.mode === "2p" ? VERSUS : SOLO, window, document);
  const scripts: [ScriptSource, ScriptSource] = [new ScriptSource(), new ScriptSource()];
  const sources: [InputSource, InputSource] =
    opts.mode === "2p"
      ? [new KeyboardSource(kb, 0), new KeyboardSource(kb, 1)]
      : opts.mode === "cpu"
        ? [new KeyboardSource(kb, 0), new CpuSource(opts.matchId, 1, opts.difficulty)]
        : [new CpuSource(opts.matchId, 0, "hard"), new CpuSource(opts.matchId, 1, opts.difficulty)];
  // Debug injection ORs a scripted mask into each player's input.
  const merged: [InputSource, InputSource] = [
    { sample: (s, side) => sources[0].sample(s, side) | scripts[0].mask },
    { sample: (s, side) => sources[1].sample(s, side) | scripts[1].mask },
  ];
  const match = new LocalMatch(opts.matchId, merged);
  let view: FightView | null = null;
  let director: Director | null = null;
  let disposed = false;
  let lastFrame = -1;
  let ended = false;
  let started = false;

  const loop = new FixedLoop({
    tick: () => {
      if (!view || !director) return;
      const events = match.tick();
      view.tick(match.cur);
      director.tick(match.cur, events);
      // Frame times from the loading screen and countdown aren't gameplay: measure from FIGHT.
      if (events.some((e) => e.kind === "fight") && match.cur.round === 1) perf.reset();
      if (!ended && match.cur.matchWinner >= 0) {
        ended = true;
        opts.onMatchEnd?.(match.cur.matchWinner, stateHash(match.cur));
      }
    },
    render: (alpha, now) => {
      if (!view || !director) return;
      const dt = lastFrame < 0 ? STEP_MS / 1000 : Math.min(0.1, (now - lastFrame) / 1000);
      lastFrame = now;
      director.frame(loop.paused ? 0 : dt);
      renderer.info.reset();
      view.render(match.prev, match.cur, alpha, loop.paused ? 0 : dt);
      perf.frame(now, renderer);
    },
  });
  loop.manual = !!opts.manual;

  const onVisibility = () => {
    if (document.visibilityState === "hidden" && opts.mode !== "demo") {
      loop.paused = true;
      opts.hud.set({ paused: true });
    }
    loop.resetClock();
  };
  document.addEventListener("visibilitychange", onVisibility);
  const ro = new ResizeObserver(resize);
  ro.observe(host);

  const ready = (async () => {
    opts.hud.set({ loading: true, error: null, mode: opts.mode, names: names(opts.mode, opts.difficulty) });
    const gltf = await loadGltf(chickenModelUrl(), renderer);
    if (disposed) return;
    view = new FightView(renderer, gltf, opts.tiers, match.cur.rng);
    view.setQuality(quality);
    director = new Director({ camera: view.camera, particles: view.particles, ko: view.ko, hud: opts.hud, seed: match.cur.rng, tiers: opts.tiers });
    resize();
    if (opts.arena) {
      try {
        const arena = await opts.arena(renderer);
        if (disposed) {
          arena.dispose();
          return;
        }
        view.setArena(arena);
        director.hype = arena;
      } catch (e) {
        console.warn("[cockfight] arena failed to build; using the placeholder floor", e);
      }
    }
    view.ensureEnvironment(); // no arena (or it failed): bake the fallback env map before compiling
    // Prewarm every shader (KO pass included) so no frame stalls on a first-use compile.
    view.ko.apply(renderer, true);
    await renderer.compileAsync(view.scene, view.camera.camera);
    if (disposed) return;
    opts.hud.set({ loading: false });
    loop.start();
    started = true;
    canvas.focus({ preventScroll: true });
  })().catch((e: unknown) => {
    console.error("[cockfight] failed to start the fight", e);
    opts.hud.set({ loading: false, error: "Couldn't load the fight. Reload to try again." });
  });

  const handle: DebugFight = {
    ready: () => started,
    state: () => match.cur,
    events: () => match.events,
    hash: () => stateHash(match.cur),
    sounds: () => director?.recentSounds ?? [],
    fxLive: () => view?.particles.live() ?? false,
    perf: () => perf.snapshot(renderer.getPixelRatio(), quality.tier),
    clips: () => view?.chickens[0].clipCount ?? 0,
    quality: () => quality.tier,
    B,
  };
  if (opts.debug) {
    handle.setInput = (p, mask) => {
      scripts[p].mask = mask;
    };
    handle.stepTicks = (n) => loop.stepTicks(n);
    handle.pause = () => engine.pause();
    handle.resume = () => engine.resume();
  }
  const w = window as unknown as { __cockfight?: Record<string, unknown> };
  w.__cockfight = { ...(w.__cockfight ?? {}), fight: handle, rules: RULES.hash };

  const engine: FightEngine = {
    ready,
    get paused() {
      return loop.paused;
    },
    pause() {
      loop.paused = true;
      kb.releaseAll();
      opts.hud.set({ paused: true });
    },
    resume() {
      loop.paused = false;
      loop.resetClock();
      opts.hud.set({ paused: false });
      canvas.focus({ preventScroll: true });
    },
    setQuality(tier) {
      quality = qualitySettings(tier, window.devicePixelRatio || 1);
      view?.setQuality(quality);
      resize();
      perf.reset();
    },
    setShake(amount) {
      if (view) view.camera.shake.amount = amount;
    },
    setAudio(a) {
      if (director) director.audio = a;
    },
    perf: () => perf.snapshot(renderer.getPixelRatio(), quality.tier),
    resetPerf: () => perf.reset(),
    dispose() {
      disposed = true;
      loop.stop();
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      kb.dispose();
      view?.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
      const cf = w.__cockfight;
      if (cf && cf.fight === handle) delete cf.fight;
    },
  };
  return engine;
}

function names(mode: FightMode, level: CpuLevel): [string, string] {
  if (mode === "2p") return ["P1", "P2"];
  if (mode === "demo") return ["CPU", "CPU"];
  return ["YOU", `CPU (${level.toUpperCase()})`];
}
