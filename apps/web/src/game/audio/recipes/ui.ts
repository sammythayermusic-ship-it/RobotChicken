/**
 * Announcer-less UI and match cues: countdown beeps, the FIGHT stab, the
 * "super ready" sparkle, the win fanfare and menu blips (renderJuice.md §6).
 * Kept clean and bright so they cut through the crowd without clashing with
 * the bell (600 Hz family).
 */
import { chain, click, env, filter, gain, glide, noise, osc, strike, withReverb, type Recipe, type SynthContext } from "../synth";

/** A short tone: `type` at `freq`, percussive envelope. */
function blip(ctx: SynthContext, out: AudioNode, t: number, type: OscillatorType, freq: number, level: number, decay: number, hold = 0): void {
  const g = gain(ctx, 0);
  if (hold > 0) {
    env(g.gain, t, [
      [0, 0],
      [0.003, level],
      [hold, level * 0.8],
    ]);
    g.gain.exponentialRampToValueAtTime(level * 0.001, t + hold + decay);
  } else strike(g.gain, t, level, decay, 0.002);
  chain(osc(ctx, type, freq, t, hold + decay + 0.02), g, out);
}

/** A brass-like note: detuned saws through a low-pass that blooms open. */
function brass(ctx: SynthContext, out: AudioNode, t: number, freq: number, seconds: number, level: number, vibrato: boolean): void {
  const mix = gain(ctx, 0.5);
  for (const cents of [-6, 6]) {
    const o = osc(ctx, "sawtooth", freq, t, seconds + 0.02);
    o.detune.value = cents;
    if (vibrato) {
      const v = gain(ctx, 0);
      env(v.gain, t, [
        [0, 0],
        [0.25, 0],
        [0.6, 14],
      ]);
      osc(ctx, "sine", 5.5, t, seconds + 0.02).connect(v).connect(o.detune);
    }
    o.connect(mix);
  }
  const lp = filter(ctx, "lowpass", freq * 1.5, 1.2);
  env(lp.frequency, t, [
    [0, freq * 1.5],
    [0.03, Math.min(9000, freq * 7)],
    [0.15, Math.min(6000, freq * 4)],
  ]);
  const g = gain(ctx, 0);
  env(g.gain, t, [
    [0, 0],
    [0.015, level],
    [Math.max(0.03, seconds - 0.06), level * 0.8],
    [seconds, 0],
  ]);
  chain(mix, lp, g, out);
}

/** Countdown "3, 2, 1": a clean 880 Hz beep with an octave glint. */
export const countdownTick: Recipe = {
  seconds: 0.3,
  render(ctx, out, r) {
    blip(ctx, out, 0.003, "triangle", 880, 0.8, 0.14, 0.08);
    blip(ctx, out, 0.003, "sine", 1760, 0.25, 0.1, 0.04);
    click(ctx, out, 0.003, r, 0.2, 3000, 0.003);
  },
};

/** FIGHT!: a rising two-note stab at 1760 Hz over a whoosh, under the bell. */
export const fight: Recipe = {
  seconds: 0.6,
  render(ctx, out, r) {
    const wet = withReverb(ctx, out, 0.6, 0.18, r, 0.6);
    brass(ctx, wet, 0.003, 880, 0.09, 0.6, false);
    brass(ctx, wet, 0.09, 1760, 0.38, 0.75, false);
    blip(ctx, wet, 0.09, "sine", 1760, 0.35, 0.3, 0.05);
    const n = gain(ctx, 0);
    env(n.gain, 0.003, [
      [0, 0],
      [0.08, 0.3],
      [0.3, 0],
    ]);
    const bp = filter(ctx, "bandpass", 800, 1);
    glide(bp.frequency, 0.003, 800, 5000, 0.12);
    chain(noise(ctx, 0.003, 0.32, r), bp, n, wet);
  },
};

/** Heat full / SUPER READY: a quick rising arpeggio with a shimmering top note. */
export const heatFull: Recipe = {
  seconds: 0.8,
  render(ctx, out, r) {
    const wet = withReverb(ctx, out, 0.7, 0.2, r, 0.7);
    [660, 990, 1320, 1980].forEach((f, i) => blip(ctx, wet, 0.003 + i * 0.055, "triangle", f, 0.45, 0.28));
    const top = osc(ctx, "sine", 2640, 0.17, 0.55);
    const trem = gain(ctx, 0.5);
    osc(ctx, "sine", 16, 0.17, 0.55).connect(gain(ctx, 0.5)).connect(trem.gain);
    const g = gain(ctx, 0);
    strike(g.gain, 0.17, 0.3, 0.5, 0.01);
    chain(top, trem, g, wet);
  },
};

/** Victory fanfare: G-C-E-G pickup into a held C major chord. */
export const winJingle: Recipe = {
  seconds: 2.4,
  render(ctx, out, r) {
    const wet = withReverb(ctx, out, 1.3, 0.25, r, 0.5);
    const notes: [number, number, number][] = [
      [392, 0.003, 0.12],
      [523.25, 0.13, 0.12],
      [659.25, 0.26, 0.12],
      [783.99, 0.39, 0.28],
    ];
    for (const [f, t, d] of notes) brass(ctx, wet, t, f, d, 0.6, false);
    for (const f of [523.25, 659.25, 783.99, 1046.5]) brass(ctx, wet, 0.72, f, 1.25, 0.36, true);
    // Cymbal-ish sparkle on the downbeat.
    const s = gain(ctx, 0);
    strike(s.gain, 0.72, 0.25, 1.0, 0.004);
    chain(noise(ctx, 0.72, 1.05, r), filter(ctx, "highpass", 6000, 0.7), s, wet);
  },
};

export const uiMove: Recipe = {
  seconds: 0.08,
  render(ctx, out) {
    blip(ctx, out, 0.002, "triangle", 1200, 0.6, 0.05);
  },
};

export const uiSelect: Recipe = {
  seconds: 0.24,
  render(ctx, out) {
    blip(ctx, out, 0.002, "triangle", 880, 0.55, 0.07);
    blip(ctx, out, 0.065, "triangle", 1320, 0.6, 0.15);
  },
};

export const uiBack: Recipe = {
  seconds: 0.24,
  render(ctx, out) {
    blip(ctx, out, 0.002, "triangle", 660, 0.55, 0.07);
    blip(ctx, out, 0.065, "triangle", 440, 0.6, 0.15);
  },
};

/** Pause: two soft, low-passed notes stepping down, like the world holding its breath. */
export const pause: Recipe = {
  seconds: 0.32,
  render(ctx, out) {
    const lp = filter(ctx, "lowpass", 1400, 0.7);
    lp.connect(out);
    blip(ctx, lp, 0.002, "square", 740, 0.4, 0.09);
    blip(ctx, lp, 0.1, "square", 494, 0.45, 0.18);
  },
};
