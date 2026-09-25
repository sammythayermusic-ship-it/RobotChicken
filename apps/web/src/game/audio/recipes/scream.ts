/**
 * Robot-chicken screams, one per damage tier, plus the KO power-down
 * (renderJuice.md §6). A squawk is two slightly detuned saws following a
 * "bawk" pitch contour, AM at ~28 Hz for throat rasp, part ring-modulated by
 * a 90 Hz square for the robot, then two formant band-passes (~1 k / ~2.5 k)
 * whose first formant opens on the "b". The "k" is a noise tick at the end.
 */
import { chain, env, filter, gain, glide, noise, osc, shaper, strike, thump, modes, withReverb, type Recipe, type Rng, type SynthContext } from "../synth";

interface Squawk {
  /** [seconds from start, Hz] breakpoints of the pitch contour. */
  contour: readonly (readonly [number, number])[];
  seconds: number;
  level: number;
  /** 0..1 depth of the 28 Hz throat AM. */
  rasp: number;
  /** 0..1 share of the ring-modulated ("robot") signal. */
  robot: number;
  f1: number;
  f2: number;
  /** tanh drive after the formants (0 = clean). */
  drive: number;
  /** Level of the closing "k" tick. */
  k: number;
}

function squawk(ctx: SynthContext, out: AudioNode, t: number, r: Rng, s: Squawk): void {
  const d = s.seconds;
  const mix = gain(ctx, 0.5);
  // Flutter: a fast wobble on the pitch that makes it sound throaty, not synthy.
  const flutter = gain(ctx, 35);
  osc(ctx, "sine", 17, t, d + 0.02).connect(flutter);
  for (const cents of [0, 11]) {
    const saw = osc(ctx, "sawtooth", s.contour[0]?.[1] ?? 800, t, d + 0.02);
    saw.detune.value = cents;
    env(saw.frequency, t, s.contour);
    flutter.connect(saw.detune);
    saw.connect(mix);
  }

  // Throat rasp (AM) then the robot: dry + ring-modulated in parallel.
  const rasp = gain(ctx, 1 - s.rasp * 0.5);
  osc(ctx, "triangle", 28, t, d + 0.02).connect(gain(ctx, s.rasp * 0.5)).connect(rasp.gain);
  mix.connect(rasp);
  const voice = gain(ctx, 1);
  chain(rasp, gain(ctx, 1 - s.robot), voice);
  const ring = gain(ctx, 0);
  osc(ctx, "square", 90, t, d + 0.02).connect(ring.gain);
  chain(rasp, ring, gain(ctx, s.robot * 1.3), voice);

  // Formants. F1 starts closed and opens: the "b" of "bawk".
  const vca = gain(ctx, 0);
  const f1 = filter(ctx, "bandpass", s.f1 * 0.45, 3.5);
  glide(f1.frequency, t, s.f1 * 0.45, s.f1, 0.035);
  const f2 = filter(ctx, "bandpass", s.f2, 5);
  chain(voice, f1, gain(ctx, 1.4), vca);
  chain(voice, f2, gain(ctx, 1.1), vca);
  chain(voice, filter(ctx, "lowpass", 3200, 0.7), gain(ctx, 0.22), vca);
  env(vca.gain, t, [
    [0, 0],
    [0.008, s.level],
    [d * 0.7, s.level * 0.85],
    [d, 0],
  ]);
  if (s.drive > 0) chain(vca, shaper(ctx, s.drive), gain(ctx, 0.8), out);
  else vca.connect(out);

  // Breath under the voice, and the "k".
  const breath = gain(ctx, 0);
  env(breath.gain, t, [
    [0, 0],
    [0.01, s.level * 0.12 * (0.5 + s.rasp)],
    [d, 0],
  ]);
  chain(noise(ctx, t, d + 0.01, r), filter(ctx, "bandpass", s.f2 * 0.8, 1.2), breath, out);
  if (s.k > 0) {
    const k = gain(ctx, 0);
    strike(k.gain, t + d * 0.88, s.k, 0.018, 0.001);
    chain(noise(ctx, t + d * 0.88, 0.04, r), filter(ctx, "bandpass", 3200, 2), k, out);
  }
}

export const screamLight: Recipe = {
  seconds: 0.2,
  render(ctx, out, r) {
    squawk(ctx, out, 0.003, r, {
      contour: [
        [0, 700],
        [0.035, 1100],
        [0.14, 620],
      ],
      seconds: 0.15,
      level: 0.8,
      rasp: 0.3,
      robot: 0.35,
      f1: 1000,
      f2: 2500,
      drive: 0,
      k: 0.25,
    });
  },
};

export const screamMedium: Recipe = {
  seconds: 0.34,
  render(ctx, out, r) {
    squawk(ctx, out, 0.003, r, {
      contour: [
        [0, 650],
        [0.03, 1180],
        [0.12, 1080],
        [0.27, 600],
      ],
      seconds: 0.28,
      level: 0.85,
      rasp: 0.4,
      robot: 0.4,
      f1: 1050,
      f2: 2500,
      drive: 1.5,
      k: 0.3,
    });
  },
};

/** "bk-BAWWK!": a short pickup squawk, then a driven one peaking at 1.4 kHz. */
export const screamHeavy: Recipe = {
  seconds: 0.62,
  render(ctx, out, r) {
    squawk(ctx, out, 0.003, r, {
      contour: [
        [0, 820],
        [0.025, 1250],
        [0.08, 950],
      ],
      seconds: 0.09,
      level: 0.6,
      rasp: 0.4,
      robot: 0.4,
      f1: 1000,
      f2: 2500,
      drive: 2,
      k: 0,
    });
    squawk(ctx, out, 0.115, r, {
      contour: [
        [0, 900],
        [0.045, 1400],
        [0.2, 1260],
        [0.42, 640],
      ],
      seconds: 0.45,
      level: 1,
      rasp: 0.55,
      robot: 0.45,
      f1: 1150,
      f2: 2600,
      drive: 4,
      k: 0.35,
    });
  },
};

/**
 * KO: one last squawk that sags into a power-down wail, the vibrato slowing
 * and the pitch sliding to 50 Hz like a robot running out of battery, then a
 * clunk as it drops.
 */
export const screamKo: Recipe = {
  seconds: 1.7,
  loudness: 0.13,
  render(ctx, out, r) {
    const t = 0.003;
    const d = 1.25;
    const wet = withReverb(ctx, out, 1.1, 0.22, r, 0.4);
    const mix = gain(ctx, 0.5);
    const vib = osc(ctx, "sine", 9, t, d + 0.02);
    glide(vib.frequency, t, 9, 1.5, d);
    const vibDepth = gain(ctx, 0);
    env(vibDepth.gain, t, [
      [0, 25],
      [0.25, 70],
      [d, 140],
    ]);
    vib.connect(vibDepth);
    for (const cents of [0, 13]) {
      const saw = osc(ctx, "sawtooth", 1300, t, d + 0.02);
      saw.detune.value = cents;
      saw.frequency.setValueAtTime(1150, t);
      saw.frequency.linearRampToValueAtTime(1420, t + 0.07);
      saw.frequency.linearRampToValueAtTime(1250, t + 0.22);
      saw.frequency.exponentialRampToValueAtTime(50, t + d);
      vibDepth.connect(saw.detune);
      saw.connect(mix);
    }
    const voice = gain(ctx, 0.55);
    mix.connect(voice);
    // The ring-mod carrier winds down with the voice.
    const ring = gain(ctx, 0);
    const carrier = osc(ctx, "square", 90, t, d + 0.02);
    glide(carrier.frequency, t + 0.2, 90, 22, d - 0.2);
    carrier.connect(ring.gain);
    chain(mix, ring, gain(ctx, 0.6), voice);

    const lp = filter(ctx, "lowpass", 3800, 1.5);
    lp.frequency.setValueAtTime(3800, t);
    lp.frequency.setValueAtTime(3800, t + 0.2);
    lp.frequency.exponentialRampToValueAtTime(260, t + d);
    const f2 = filter(ctx, "bandpass", 2400, 4);
    glide(f2.frequency, t + 0.2, 2400, 500, d - 0.2);
    const vca = gain(ctx, 0);
    chain(voice, lp, vca);
    chain(voice, f2, gain(ctx, 0.9), vca);
    env(vca.gain, t, [
      [0, 0],
      [0.01, 1],
      [0.3, 0.9],
      [0.9, 0.7],
      [d, 0],
    ]);
    chain(vca, shaper(ctx, 2.5), gain(ctx, 0.85), wet);

    // Clunk: the robot hits the floor.
    const at = t + d + 0.03;
    thump(ctx, wet, at, 140, 40, 0.07, 0.8, 0.25);
    modes(ctx, wet, at, 330, [1, 2.76, 5.4], [0.2, 0.14, 0.07], [0.3, 0.2, 0.1]);
    const n = gain(ctx, 0);
    strike(n.gain, at, 0.3, 0.08);
    chain(noise(ctx, at, 0.1, r), filter(ctx, "bandpass", 1200, 0.8), n, wet);
  },
};
