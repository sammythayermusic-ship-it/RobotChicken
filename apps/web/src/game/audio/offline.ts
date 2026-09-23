/**
 * Renders a recipe once into a mono 44.1 kHz AudioBuffer with an
 * OfflineAudioContext (not autoplay-gated, runs off the main thread), then
 * post-processes it: loop cross-fade, loudness normalisation, end fade.
 */
import { fadeOut, loopCrossfade, normalize } from "./dsp";
import type { SoundName } from "./names";
import { rng, type Recipe } from "./synth";

export const SAMPLE_RATE = 44100;

/** Fixed per-name seed: one variant per sound, identical on every load. */
export function seedFor(name: SoundName): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

export async function renderRecipe(name: SoundName, recipe: Recipe, sampleRate = SAMPLE_RATE): Promise<AudioBuffer> {
  const period = Math.ceil(recipe.seconds * sampleRate);
  const tail = recipe.loopTail ? Math.ceil(recipe.loopTail * sampleRate) : 0;
  const ctx = new OfflineAudioContext(1, period + tail, sampleRate);
  const out = ctx.createGain();
  out.connect(ctx.destination);
  recipe.render(ctx, out, rng(seedFor(name)));
  const rendered = await ctx.startRendering();
  if (!tail) {
    const d = rendered.getChannelData(0);
    normalize(d, sampleRate, 0.89, recipe.loudness);
    fadeOut(d, Math.round(sampleRate * 0.004));
    return rendered;
  }
  const loop = loopCrossfade(rendered.getChannelData(0), period);
  normalize(loop, sampleRate, 0.89, recipe.loudness);
  const buf = new AudioBuffer({ length: period, numberOfChannels: 1, sampleRate });
  buf.copyToChannel(loop, 0);
  return buf;
}
