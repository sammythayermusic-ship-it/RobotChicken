import { ACESFilmicToneMapping, SRGBColorSpace, WebGLRenderer } from "three";
import { B, RULES, expandInputs, stateHash, type CpuLevel, type MatchState, type Replay, type SimEvent } from "@cockfight/sim";
import type { Tier } from "@cockfight/shared";
import type { AudioSink } from "../fx/director";
import { Director } from "../fx/director";
import type { HudStore } from "../hud/hudStore";
import type { NetSession } from "../net/session";
import type { MatchDriver } from "../match/driver";
import { LocalMatch } from "../match/LocalMatch";
import { OnlineMatch } from "../match/OnlineMatch";
import { SOLO, VERSUS } from "../match/input/bindings";
import { KeyboardInput } from "../match/input/keyboard";
import { CpuSource, KeyboardSource, ReplaySource, ScriptSource, TouchSource, type InputSource } from "../match/input/source";
import { TouchInput } from "../match/input/touch";
import type { ArenaView } from "../view/FightView";
import { FightView } from "../view/FightView";
import { loadGltf } from "./assets";
import { disposeRenderer } from "./disposeRenderer";
import { FixedLoop, STEP_MS } from "./loop";
import { chickenModelUrl } from "./models";
import { PerfMeter, type PerfSnapshot } from "./perf";
import { qualitySettings, type QualityTier } from "./quality";

export { chickenModelUrl };
export type FightMode = "cpu" | "2p" | "demo" | "online" | "replay";

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
  /** Debug only: in a CPU fight, P2 stands still (e2e checks P1's touch input without the CPU in the way). */
  idleCpu?: boolean;
  /**
   * Build the procedural arena (loaded lazily); off for the fastest tests.
   * Pass a function defined at module scope: an inline arrow in a React
   * component shares that render's scope, so whatever else the scope holds
   * (the previous engine, say) stays alive for as long as this engine keeps
   * the arrow.
   */
  arena?: (renderer: WebGLRenderer) => Promise<ArenaView>;
  /** Bench mode: keep every frame time of the match (not a rolling window). */
  bench?: boolean;
  /** Attach an audio engine once the user has interacted. */
  audio?: () => Promise<AudioSink | null>;
  /** Camera shake scale (1 full, 0.3 reduced, 0 off). setShake() changes it later. */
  shake?: number;
  onMatchEnd?: (winner: number, replayHash: string) => void;
  /** Online: the fight room session (joined, handlers registered). */
  net?: NetSession;
  /** Replay: the recorded match (both players' buttons). */
  replay?: Replay;
  /** HUD names; defaults by mode. */
  names?: [string, string];
}

export interface FightEngine {
  readonly ready: Promise<void>;
  pause(): void;
  resume(): void;
  readonly paused: boolean;
  setQuality(tier: QualityTier): void;
  setShake(amount: number): void;
  setAudio(a: AudioSink | null): void;
  /** The on-screen buttons (VS CPU only: they play P1). */
  readonly touch: TouchInput | null;
  /**
   * How far (CSS px) on-screen buttons reach up into the bottom of the
   * canvas. The camera keeps a share of it clear of the fighters' feet.
   */
  setBottomInset(px: number): void;
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
  matchId(): string;
  /** The loop is paused (the pause menu, or a hidden tab). */
  paused(): boolean;
  /** The camera's shake scale (-1 until the view exists). */
  shake(): number;
  /** The bottom inset (CSS px) the page reported for the on-screen buttons, and the share the camera keeps clear. */
  insets(): { bottomPx: number; bottomFrac: number };
  /** The on-screen buttons' mask on the last tick (0 without touch). */
  touchMask(): number;
  /** Online: the session's side, status and prediction stats (null offline). */
  net(): { side: 0 | 1; status: string; present: number; confirmedTick: number; confirmedHash: string; stats: Record<string, number> } | null;
  setInput?(player: 0 | 1, mask: number): void;
  stepTicks?(n: number): void;
  pause?(): void;
  resume?(): void;
  B: typeof B;
}

export function createFightEngine(host: HTMLElement, opts: FightOptions): FightEngine {
  // Copy what the engine needs and never read `opts` from a closure below. An
  // engine handle that outlives its fight (a stale React closure, a devtools
  // reference) then keeps a few values alive, not the caller's options object.
  const { mode, difficulty, tiers, matchId, hud } = opts;
  let buildArena = opts.arena ?? null;
  let onMatchEnd = opts.onMatchEnd ?? null;
  let shake = opts.shake ?? 1;

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
  let bottomInset = 0;

  const net = mode === "online" ? (opts.net ?? null) : null;
  if (mode === "online" && !net) throw new Error("online fight without a session");
  const replay = mode === "replay" ? (opts.replay ?? null) : null;
  if (mode === "replay" && !replay) throw new Error("replay fight without a replay");
  /** The side this browser's player controls (null: nobody, or two players on one keyboard). */
  const you: 0 | 1 | null = net ? net.side : mode === "cpu" ? 0 : null;

  const kb = new KeyboardInput(mode === "2p" ? VERSUS : SOLO, window, document);
  // The on-screen buttons play this browser's fighter (against the CPU or online), alongside the keyboard (same bits).
  const touch = you !== null ? new TouchInput(window, document) : null;
  const touchSrc = touch ? new TouchSource(touch) : null;
  const scripts: [ScriptSource, ScriptSource] = [new ScriptSource(), new ScriptSource()];
  const sources: [InputSource, InputSource] =
    mode === "2p"
      ? [new KeyboardSource(kb, 0), new KeyboardSource(kb, 1)]
      : mode === "cpu"
        ? [new KeyboardSource(kb, 0), opts.debug && opts.idleCpu ? new ScriptSource() : new CpuSource(matchId, 1, difficulty)]
        : replay
          ? [new ReplaySource(expandInputs(replay.p1, replay.ticks)), new ReplaySource(expandInputs(replay.p2, replay.ticks))]
          : [new CpuSource(matchId, 0, "hard"), new CpuSource(matchId, 1, difficulty)];
  let match: MatchDriver;
  if (net) {
    // Online: this browser plays one side; the keyboard's player-1 keys and the on-screen buttons drive it.
    const kbSrc = new KeyboardSource(kb, 0);
    match = new OnlineMatch(net, (s, side) => kbSrc.sample() | (touchSrc ? touchSrc.sample(s, side) : 0) | scripts[side].mask);
  } else {
    // Debug injection ORs a scripted mask into each player's input.
    const merged: [InputSource, InputSource] = [
      { sample: (s, side) => sources[0].sample(s, side) | (touchSrc ? touchSrc.sample(s, side) : 0) | scripts[0].mask },
      { sample: (s, side) => sources[1].sample(s, side) | scripts[1].mask },
    ];
    match = new LocalMatch(replay ? replay.matchId : matchId, merged);
  }
  let view: FightView | null = null;
  let director: Director | null = null;
  let disposed = false;
  let lastFrame = -1;
  let ended = false;
  let started = false;

  const loop = new FixedLoop({
    tick: () => {
      if (!view || !director) return;
      // A replay stops where its log ends (a forfeit ends a match mid-round).
      if (replay && match.cur.tick >= replay.ticks) return;
      const events = match.tick();
      view.tick(match.cur);
      director.tick(match.cur, events);
      // Frame times from the loading screen and countdown aren't gameplay: measure from FIGHT.
      if (events.some((e) => e.kind === "fight") && match.cur.round === 1) perf.reset();
      if (!ended && match.cur.matchWinner >= 0) {
        ended = true;
        onMatchEnd?.(match.cur.matchWinner, stateHash(match.cur));
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

  /** Stops the sim and hands the keyboard to the pause menu: nothing pressed there reaches the fight. */
  const pause = () => {
    // An online match runs on the server: there is nothing to pause.
    if (net) return;
    loop.paused = true;
    kb.setEnabled(false);
    touch?.setEnabled(false);
    hud.set({ paused: true });
  };

  const onVisibility = () => {
    if (document.visibilityState === "hidden" && mode !== "demo" && mode !== "replay") pause();
    loop.resetClock();
  };
  document.addEventListener("visibilitychange", onVisibility);
  const ro = new ResizeObserver(resize);
  ro.observe(host);

  // A new fight starts from a clean HUD. The page keeps one store for its
  // whole lifetime, so the last fight's pause flag, winner, round wins, banner
  // and bars must not carry over into this one.
  hud.reset({ loading: true, mode, you, names: opts.names ?? names(mode, difficulty) });

  const ready = (async () => {
    const gltf = await loadGltf(chickenModelUrl(), renderer);
    if (disposed) return;
    view = new FightView(renderer, gltf, tiers, match.cur.rng);
    view.setQuality(quality);
    view.camera.shake.amount = shake;
    view.setBottomInset(bottomInset);
    director = new Director({ camera: view.camera, particles: view.particles, ko: view.ko, hud, seed: match.cur.rng, tiers });
    resize();
    const arenaFactory = buildArena;
    buildArena = null;
    if (arenaFactory) {
      try {
        const arena = await arenaFactory(renderer);
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
    hud.set({ loading: false });
    loop.start();
    started = true;
    // Online: tell the server this player has loaded; the match starts when both have.
    net?.ready();
    canvas.focus({ preventScroll: true });
  })().catch((e: unknown) => {
    // A disposed engine no longer owns the HUD: the next fight does.
    if (disposed) return;
    console.error("[cockfight] failed to start the fight", e);
    hud.set({ loading: false, error: "Couldn't load the fight. Reload to try again." });
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
    matchId: () => matchId,
    paused: () => loop.paused,
    shake: () => view?.camera.shake.amount ?? -1,
    insets: () => ({ bottomPx: bottomInset, bottomFrac: view?.camera.bottomFrac ?? 0 }),
    touchMask: () => touch?.lastMask ?? 0,
    net: () =>
      net
        ? {
            side: net.side,
            status: net.snapshot().status,
            present: net.pred.present,
            confirmedTick: net.pred.confirmed?.tick ?? -1,
            confirmedHash: net.pred.confirmed ? stateHash(net.pred.confirmed) : "",
            stats: { ...net.pred.stats, corrections: net.pred.stats.corrections.length },
          }
        : null,
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
    pause,
    resume() {
      // Enabling the keyboard drops anything held or latched, so no key
      // pressed while paused fires on the first tick after it.
      kb.setEnabled(true);
      touch?.setEnabled(true);
      loop.paused = false;
      loop.resetClock();
      hud.set({ paused: false });
      canvas.focus({ preventScroll: true });
    },
    setQuality(tier) {
      quality = qualitySettings(tier, window.devicePixelRatio || 1);
      view?.setQuality(quality);
      resize();
      perf.reset();
    },
    setShake(amount) {
      // Kept, not only applied: the camera exists only once the model has loaded.
      shake = amount;
      if (view) view.camera.shake.amount = amount;
    },
    setAudio(a) {
      if (director) director.audio = a;
    },
    touch,
    setBottomInset(px) {
      // Kept, not only applied: the view exists only once the model has loaded.
      bottomInset = Math.max(0, px);
      view?.setBottomInset(bottomInset);
    },
    perf: () => perf.snapshot(renderer.getPixelRatio(), quality.tier),
    resetPerf: () => perf.reset(),
    dispose() {
      if (disposed) return;
      disposed = true;
      loop.stop();
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      kb.dispose();
      touch?.dispose();
      // Release the GPU side while the chickens and the arena are still in
      // the scene. Their glTF geometries and textures are shared through
      // loadGltf's cache and, like three's DFG LUT, hold a dispose listener
      // for every renderer that uploaded them. Releasing them (and the LUT)
      // is what lets this renderer, its canvas and its context be collected.
      const env = view?.arenaView?.envScene;
      disposeRenderer(renderer, ...(view ? [view.scene] : []), ...(env ? [env] : []));
      view?.dispose();
      view = null;
      director = null;
      buildArena = null;
      onMatchEnd = null;
      canvas.remove();
      const cf = w.__cockfight;
      if (cf && cf.fight === handle) delete cf.fight;
    },
  };
  return engine;
}

function names(mode: FightMode, level: CpuLevel): [string, string] {
  if (mode === "2p" || mode === "online" || mode === "replay") return ["P1", "P2"];
  if (mode === "demo") return ["CPU", "CPU"];
  return ["YOU", `CPU (${level.toUpperCase()})`];
}
