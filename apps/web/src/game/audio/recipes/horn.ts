/**
 * Horns and synth stabs: the KO air horn, the time-up buzzer and the super
 * charge-up riser (renderJuice.md §6).
 */
import { chain, env, filter, gain, glide, modes, noise, osc, shaper, withReverb, type Recipe } from "../synth";

/**
 * Stadium air horn: three detuned saws (233 / 236 / 311 Hz) with an octave
 * sub, bending up into pitch at the onset, low-passed at 1.8 kHz and driven.
 */
export const koHorn: Recipe = {
  seconds: 2.1,
  loudness: 0.16,
  render(ctx, out, r) {
    const t = 0.003;
    const d = 1.4;
    const wet = withReverb(ctx, out, 1.3, 0.25, r, 0.4);
    const mix = gain(ctx, 0.3);
    for (const [f, lvl] of [
      [233, 1],
      [236, 0.9],
      [311, 0.75],
      [116.5, 0.6],
    ] as const) {
      const o = osc(ctx, "sawtooth", f, t, d + 0.05);
      env(o.frequency, t, [
        [0, f * 0.82],
        [0.07, f * 1.01],
        [0.12, f],
        [d - 0.15, f],
        [d, f * 0.94],
      ]);
      chain(o, gain(ctx, lvl), mix);
    }
    const lp = filter(ctx, "lowpass", 500, 2);
    env(lp.frequency, t, [
      [0, 500],
      [0.04, 2600],
      [0.25, 1800],
      [d - 0.2, 1600],
      [d, 700],
    ]);
    const vca = gain(ctx, 0);
    env(vca.gain, t, [
      [0, 0],
      [0.02, 1],
      [0.2, 0.85],
      [d - 0.2, 0.8],
      [d, 0],
    ]);
    chain(mix, shaper(ctx, 2.5), lp, vca, wet);
    // The rasp of the reed, a little noise riding the envelope.
    const n = gain(ctx, 0);
    env(n.gain, t, [
      [0, 0],
      [0.02, 0.06],
      [d, 0],
    ]);
    chain(noise(ctx, t, d, r), filter(ctx, "bandpass", 1500, 1), n, wet);
  },
};

/** Time up: a raspy game-show buzzer. */
export const timeout: Recipe = {
  seconds: 1.0,
  render(ctx, out) {
    const t = 0.003;
    const d = 0.85;
    const mix = gain(ctx, 0.3);
    for (const [f, type] of [
      [147, "square"],
      [149.5, "square"],
      [294, "sawtooth"],
    ] as const) {
      chain(osc(ctx, type, f, t, d + 0.02), mix);
    }
    // 30 Hz chop: the buzz of a cheap relay.
    const chop = gain(ctx, 0.65);
    osc(ctx, "square", 30, t, d + 0.02).connect(gain(ctx, 0.35)).connect(chop.gain);
    const vca = gain(ctx, 0);
    env(vca.gain, t, [
      [0, 0],
      [0.01, 1],
      [d - 0.08, 0.9],
      [d, 0],
    ]);
    chain(mix, chop, shaper(ctx, 2), filter(ctx, "lowpass", 2400, 0.8), vca, out);
  },
};

/** Super charge-up: a rising saw pair with a noise roar opening under it, ending on a bright "shing". */
export const superStart: Recipe = {
  seconds: 1.1,
  render(ctx, out, r) {
    const t = 0.003;
    const rise = 0.7;
    const wet = withReverb(ctx, out, 0.9, 0.2, r, 0.6);
    const mix = gain(ctx, 0.4);
    for (const cents of [0, 14, -9]) {
      const o = osc(ctx, "sawtooth", 200, t, rise + 0.12);
      o.detune.value = cents;
      glide(o.frequency, t, 200, 1200, rise);
      o.connect(mix);
    }
    const bp = filter(ctx, "bandpass", 500, 1.4);
    glide(bp.frequency, t, 500, 3600, rise);
    const vca = gain(ctx, 0);
    env(vca.gain, t, [
      [0, 0],
      [rise * 0.9, 0.9],
      [rise, 1],
      [rise + 0.1, 0],
    ]);
    // A low ring-mod growl under the riser: the reactor spinning up.
    const ring = gain(ctx, 0);
    const car = osc(ctx, "square", 40, t, rise + 0.12);
    glide(car.frequency, t, 40, 160, rise);
    car.connect(ring.gain);
    chain(mix, bp, vca, shaper(ctx, 2), wet);
    chain(mix, ring, filter(ctx, "lowpass", 900, 0.8), gain(ctx, 0.5), vca);

    const roar = gain(ctx, 0);
    env(roar.gain, t, [
      [0, 0],
      [rise, 0.55],
      [rise + 0.15, 0],
    ]);
    const lp = filter(ctx, "lowpass", 300, 0.9);
    glide(lp.frequency, t, 300, 7000, rise);
    chain(noise(ctx, t, rise + 0.2, r, "pink"), lp, roar, wet);
    modes(ctx, wet, t + rise, 1760, [1, 2.76, 5.4], [0.3, 0.2, 0.1], [0.35, 0.2, 0.1]);
  },
};
