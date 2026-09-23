import type { AudioSink } from "../fx/director";
import { installDebug } from "../engine/debug";
import { AudioEngine, type SoundSource } from "./engine";
import { browserDeps, loadSounds } from "./loader";
import { SOUND_NAMES, type SoundName } from "./names";

export type GameAudio = AudioSink & {
  setMuted(m: boolean): void;
  /** The context is running (sounds can play). */
  readonly running: boolean;
  /**
   * Asks a suspended context to start; call it from a user gesture. Resolves
   * true once it runs. Without a gesture the browser leaves the promise
   * pending until one arrives, so never await it where that would hang.
   */
  resume(): Promise<boolean>;
  dispose(): void;
};

/** `window.__cockfight.audio` (read-only; e2e and console). */
export interface AudioDebug {
  state(): AudioContextState;
  /** Sounds with a buffer so far (of `total()`). */
  rendered(): number;
  total(): number;
  /** Sounds the engine actually started, newest last. */
  played(): readonly SoundName[];
  /** ms from creating the audio (the FIGHT click, or an autostart link loading) until all sounds / the first-exchange sounds were ready (-1 = not yet). */
  readyMs(): number;
  firstHitsMs(): number;
  source(name: SoundName): SoundSource | null;
  buffer(name: SoundName): AudioBuffer | null;
}

declare module "../engine/debug" {
  interface CockfightDebug {
    audio?: AudioDebug;
  }
}

/**
 * Creates the game's audio engine. Called from a user gesture (the FIGHT
 * click) the AudioContext starts at once: it is created and resumed
 * synchronously, before any await. Called without one (an autostart link,
 * while LOADING is up) the context waits suspended, and `resume()` from the
 * first gesture starts it. The constructor blocks the main thread for about
 * 130 ms on desktop Chrome, so create it where a stall does not show, never
 * mid-fight. Sounds render in the background in priority order; this
 * resolves without waiting for them. Returns null when WebAudio is
 * unavailable; the game plays silently.
 */
export async function createAudio(): Promise<GameAudio | null> {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor || typeof OfflineAudioContext === "undefined") return null;
  let ctx: AudioContext;
  try {
    ctx = new Ctor({ latencyHint: "interactive" });
  } catch {
    return null;
  }
  // Not awaited: a resume the browser refuses would otherwise hang the FIGHT click.
  ctx.resume().catch(() => {});
  const engine = new AudioEngine(ctx);

  // A hidden tab stops the fight; stop the audio thread too (battery), and pick up where it left off.
  const onVisibility = () => {
    if (engine.isDisposed) return;
    const p = document.visibilityState === "hidden" ? ctx.suspend() : ctx.resume();
    p.catch(() => {});
  };
  document.addEventListener("visibilitychange", onVisibility);

  const uninstall = installDebug("audio", {
    state: () => ctx.state,
    rendered: () => engine.ready,
    total: () => SOUND_NAMES.length,
    played: () => engine.played.slice(),
    readyMs: () => engine.readyMs,
    firstHitsMs: () => engine.firstHitsMs,
    source: (n) => engine.sourceOf(n),
    buffer: (n) => engine.buffer(n),
  });

  void loadSounds(engine, browserDeps(engine)).catch((e: unknown) => console.warn("[cockfight] audio: sounds failed to load", e));

  return {
    play: (name, opts) => engine.play(name, opts),
    setHype: (h) => engine.setHype(h),
    setMuted: (m) => engine.setMuted(m),
    get running() {
      return !engine.isDisposed && ctx.state === "running";
    },
    resume: () => {
      // A hidden tab keeps its context suspended (see onVisibility).
      if (engine.isDisposed || document.visibilityState === "hidden") return Promise.resolve(false);
      return ctx.resume().then(
        () => !engine.isDisposed && ctx.state === "running",
        () => false,
      );
    },
    dispose: () => {
      document.removeEventListener("visibilitychange", onVisibility);
      uninstall();
      engine.dispose();
    },
  };
}
