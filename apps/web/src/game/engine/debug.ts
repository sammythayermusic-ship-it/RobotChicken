/**
 * `window.__cockfight`: read-only handles for e2e tests and the console.
 * Each engine piece installs its own entry and removes it on dispose, so a
 * StrictMode remount never leaves a handle pointing at a dead instance.
 */

export interface ShowcaseDebug {
  /** A frame with both chickens (glb or fallback) has been rendered. */
  readonly ready: boolean;
  /** The glb could not be loaded and box chickens are shown instead. */
  readonly fallback: boolean;
  /** Clip names in the loaded glb (empty for the fallback). */
  readonly clips: readonly string[];
  readonly error: string | null;
  /** Held still, by the page's pause control or by prefers-reduced-motion. */
  readonly paused: boolean;
  /** prefers-reduced-motion: reduce, as the showcase currently sees it. */
  readonly reducedMotion: boolean;
  /** Frames drawn so far. It stays put while the showcase holds still. */
  readonly frames: number;
}

export interface CockfightDebug {
  showcase?: ShowcaseDebug;
}

declare global {
  interface Window {
    __cockfight?: CockfightDebug;
  }
}

export function installDebug<K extends keyof CockfightDebug>(key: K, handle: NonNullable<CockfightDebug[K]>): () => void {
  if (typeof window === "undefined") return () => {};
  const root = (window.__cockfight ??= {});
  root[key] = handle;
  return () => {
    if (window.__cockfight?.[key] === handle) delete window.__cockfight[key];
  };
}
