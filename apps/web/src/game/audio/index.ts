import type { AudioSink } from "../fx/director";
import { installDebug } from "../engine/debug";
import { AudioEngine, type SoundSource } from "./engine";
import { fileUrl, loadManifest } from "./manifest";
import { SOUND_NAMES, type SoundName } from "./names";

export type GameAudio = AudioSink & { setMuted(m: boolean): void; dispose(): void };

/** `window.__cockfight.audio` (read-only; e2e and console). */
export interface AudioDebug {
  state(): AudioContextState;
  /** Sounds with a buffer so far (of `total()`). */
  rendered(): number;
  total(): number;
  /** Sounds the engine actually started, newest last. */
  played(): readonly SoundName[];
  /** ms from the FIGHT click until all sounds / the first-exchange sounds were ready (-1 = not yet). */
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

const RENDER_CONCURRENCY = 3;

/**
 * Creates the game's audio engine. Must be called from a user gesture (the
 * FIGHT click) so the AudioContext may start: the context is created and
 * resumed synchronously, before any await. Sounds render in the background
 * in priority order; this resolves without waiting for them. Returns null
 * when WebAudio is unavailable; the game plays silently.
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

  void loadSounds(engine).catch((e: unknown) => console.warn("[cockfight] audio: sounds failed to load", e));

  return {
    play: (name, opts) => engine.play(name, opts),
    setHype: (h) => engine.setHype(h),
    setMuted: (m) => engine.setMuted(m),
    dispose: () => {
      document.removeEventListener("visibilitychange", onVisibility);
      uninstall();
      engine.dispose();
    },
  };
}

/**
 * Fills the engine: procedural recipes render in RENDER_ORDER (a few at a
 * time), while manifest-listed files are fetched and decoded alongside. A
 * decoded file always wins; a file that fails falls back to its recipe.
 */
async function loadSounds(engine: AudioEngine): Promise<void> {
  const t0 = performance.now();
  const manifest = loadManifest();
  const [{ RECIPES, RENDER_ORDER, FIRST_HITS }, { renderRecipe }] = await Promise.all([import("./recipes"), import("./offline")]);
  const queue = RENDER_ORDER.slice();
  const fromFile = new Set<SoundName>();
  let renderMs = 0;

  const markProgress = () => {
    if (engine.firstHitsMs < 0 && FIRST_HITS.every((n) => engine.has(n))) engine.firstHitsMs = Math.round(performance.now() - t0);
  };

  const render = async (name: SoundName) => {
    const t = performance.now();
    try {
      const buf = await renderRecipe(name, RECIPES[name]);
      if (!engine.has(name)) engine.setBuffer(name, buf, "recipe");
    } catch (e) {
      console.warn(`[cockfight] audio: recipe ${name} failed to render`, e);
    }
    renderMs += performance.now() - t;
    markProgress();
  };

  const worker = async () => {
    for (let name = queue.shift(); name && !engine.isDisposed; name = queue.shift()) {
      if (fromFile.has(name) || engine.has(name)) continue;
      await render(name);
    }
  };

  const files = manifest.then(async (entries) => {
    const listed = Object.entries(entries) as [SoundName, string][];
    for (const [name] of listed) fromFile.add(name);
    await Promise.all(
      listed.map(async ([name, file]) => {
        try {
          const res = await fetch(fileUrl(file));
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const buf = await engine.ctx.decodeAudioData(await res.arrayBuffer());
          if (!engine.isDisposed) engine.setBuffer(name, buf, "file");
          markProgress();
        } catch (e) {
          console.warn(`[cockfight] audio: ${file} failed (${String(e)}); using the procedural ${name}`);
          fromFile.delete(name);
          if (!engine.has(name) && !engine.isDisposed) await render(name);
        }
      }),
    );
  });

  await Promise.all([...Array.from({ length: RENDER_CONCURRENCY }, worker), files]);
  if (engine.isDisposed) return;
  engine.readyMs = Math.round(performance.now() - t0);
  const fileCount = SOUND_NAMES.filter((n) => engine.sourceOf(n) === "file").length;
  console.info(
    `[cockfight] audio: ${engine.ready}/${SOUND_NAMES.length} sounds ready in ${engine.readyMs} ms ` +
      `(first hits ${engine.firstHitsMs} ms; ${engine.ready - fileCount} procedural, ${Math.round(renderMs)} ms of render work; ${fileCount} from files)`,
  );
}
