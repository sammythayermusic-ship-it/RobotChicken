import type { AudioSink } from "../fx/director";

/**
 * Creates the game's audio engine. Must be called from a user gesture (the
 * FIGHT click) so the AudioContext may start. Returns null when WebAudio is
 * unavailable; the game plays silently.
 */
export async function createAudio(): Promise<(AudioSink & { setMuted(m: boolean): void; dispose(): void }) | null> {
  return null;
}
