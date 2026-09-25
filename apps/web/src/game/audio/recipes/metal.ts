/**
 * The robot body: impacts, blocks, whiffs, servos, landings and the ring-out
 * crash (renderJuice.md §6). Every hit
 * is click + band-passed "smack" + struck-bar modes (1 : 2.76 : 5.40 : 8.93)
 * + a falling sine thump; heavier hits drop the modes, lengthen the ring,
 * add tanh crunch, a debris sweep, a boom and baked reverb.
 */
import { between, chain, click, env, filter, gain, glide, modes, noise, osc, shaper, strike, thump, withReverb, type Recipe, type Rng, type SynthContext } from "../synth";

const BAR = [1, 2.76, 5.4, 8.93] as const;

/** Band-passed noise burst: the dull "smack" of plate on plate under the ring. */
function smack(ctx: SynthContext, out: AudioNode, t: number, r: Rng, freq: number, level: number, decay: number): void {
  const g = gain(ctx, 0);
  strike(g.gain, t, level, decay, 0.001);
  chain(noise(ctx, t, decay + 0.02, r), filter(ctx, "bandpass", freq, 0.9), g, out);
}

/** Noise through a low-pass sweeping down: grit and debris after a big hit. */
function crunch(ctx: SynthContext, out: AudioNode, t: number, r: Rng, level: number, seconds: number): void {
  const lp = filter(ctx, "lowpass", 6000, 1.2);
  glide(lp.frequency, t, 6000, 600, seconds);
  const g = gain(ctx, 0);
  strike(g.gain, t, level, seconds, 0.002);
  chain(noise(ctx, t, seconds + 0.02, r), lp, g, out);
}

/** Loose screws and plates: small high clinks scattered after the impact. */
function debris(ctx: SynthContext, out: AudioNode, t: number, r: Rng, count: number, spread: number, level: number): void {
  for (let i = 0; i < count; i++) {
    const at = t + between(r, 0.05, spread) * (0.4 + 0.6 * (i / count));
    const base = between(r, 1800, 3600);
    modes(ctx, out, at, base, [1, 2.76], [level * between(r, 0.5, 1), level * 0.4], [between(r, 0.05, 0.11), 0.04], 0);
  }
}

/** Sub boom under slams and supers (felt more than heard). */
function boom(ctx: SynthContext, out: AudioNode, t: number, r: Rng, level: number, seconds: number): void {
  thump(ctx, out, t, 75, 28, seconds * 0.5, level, seconds);
  const g = gain(ctx, 0);
  strike(g.gain, t, level * 0.5, seconds * 0.8, 0.01);
  chain(noise(ctx, t, seconds, r, "brown"), filter(ctx, "lowpass", 220, 0.8), g, out);
}

interface Impact {
  /** First bar mode, Hz, and the ratio of a second, smaller plate (two parts colliding). */
  base: number;
  plate: number;
  /** Decay of the first mode, s (higher modes decay proportionally faster). */
  ring: number;
  metal: number;
  smackHz: number;
  smack: number;
  smackDecay: number;
  /** Sine thump: from Hz, to Hz, level, decay s. */
  thump: readonly [number, number, number, number];
  /** Drive on the body layer only, so the metal ring stays clear while the thump crunches. */
  drive: number;
  crunch: number;
  crunchSeconds: number;
  click: number;
  clickHp: number;
}

/** The layers every hit shares: metal (modes + click) and body (smack + crunch + thump). */
function impact(ctx: SynthContext, out: AudioNode, t: number, r: Rng, p: Impact): AudioNode {
  const metal = gain(ctx, 1);
  chain(metal, shaper(ctx, 1.3), out);
  const body = gain(ctx, 1);
  chain(body, shaper(ctx, p.drive), out);
  click(ctx, metal, t, r, p.click, p.clickHp, 0.005);
  modes(
    ctx,
    metal,
    t,
    p.base,
    BAR,
    [0.4, 0.32, 0.22, 0.13].map((a) => a * p.metal),
    [1, 0.65, 0.42, 0.27].map((d) => d * p.ring),
  );
  modes(
    ctx,
    metal,
    t,
    p.base * p.plate,
    BAR.slice(0, 3),
    [0.18, 0.12, 0.06].map((a) => a * p.metal),
    [0.55, 0.37, 0.2].map((d) => d * p.ring),
    0,
  );
  smack(ctx, body, t, r, p.smackHz, p.smack, p.smackDecay);
  if (p.crunch > 0) crunch(ctx, body, t, r, p.crunch, p.crunchSeconds);
  const [from, to, level, decay] = p.thump;
  thump(ctx, body, t, from, to, Math.min(0.14, decay * 0.35), level, decay);
  return body;
}

export const hitLight: Recipe = {
  seconds: 0.5,
  render(ctx, out, r) {
    impact(ctx, out, 0.002, r, {
      base: 560,
      plate: 1.47,
      ring: 0.26,
      metal: 0.9,
      smackHz: 1500,
      smack: 0.55,
      smackDecay: 0.045,
      thump: [170, 60, 0.8, 0.11],
      drive: 1.4,
      crunch: 0,
      crunchSeconds: 0,
      click: 0.8,
      clickHp: 3000,
    });
  },
};

export const hitHeavy: Recipe = {
  seconds: 0.85,
  render(ctx, out, r) {
    impact(ctx, out, 0.002, r, {
      base: 250,
      plate: 1.61,
      ring: 0.55,
      metal: 1.1,
      smackHz: 1100,
      smack: 0.6,
      smackDecay: 0.07,
      thump: [160, 42, 0.9, 0.26],
      drive: 3,
      crunch: 0.22,
      crunchSeconds: 0.28,
      click: 0.9,
      clickHp: 2200,
    });
  },
};

export const hitSlam: Recipe = {
  seconds: 1.3,
  render(ctx, out, r) {
    const t = 0.002;
    const wet = withReverb(ctx, out, 1.1, 0.22, r, 0.45);
    const body = impact(ctx, wet, t, r, {
      base: 190,
      plate: 1.53,
      ring: 0.8,
      metal: 1.1,
      smackHz: 850,
      smack: 0.7,
      smackDecay: 0.1,
      thump: [150, 34, 0.9, 0.45],
      drive: 3.5,
      crunch: 0.3,
      crunchSeconds: 0.42,
      click: 1,
      clickHp: 1800,
    });
    boom(ctx, body, t, r, 0.6, 0.9);
    debris(ctx, wet, t, r, 5, 0.45, 0.07);
  },
};

export const hitSuper: Recipe = {
  seconds: 1.8,
  render(ctx, out, r) {
    const t = 0.002;
    const wet = withReverb(ctx, out, 1.5, 0.28, r, 0.5);
    const body = impact(ctx, wet, t, r, {
      base: 165,
      plate: 1.53,
      ring: 1.0,
      metal: 1.15,
      smackHz: 700,
      smack: 0.8,
      smackDecay: 0.12,
      thump: [140, 30, 1, 0.55],
      drive: 4,
      crunch: 0.35,
      crunchSeconds: 0.55,
      click: 1,
      clickHp: 1500,
    });
    boom(ctx, body, t, r, 0.75, 1.3);
    // Electric discharge: a ring-modulated saw diving from a crackle to a growl.
    const zap = osc(ctx, "sawtooth", 2200, t, 0.5);
    glide(zap.frequency, t, 2200, 110, 0.45);
    const rm = gain(ctx, 0);
    osc(ctx, "square", 57, t, 0.5).connect(rm.gain);
    const zg = gain(ctx, 0);
    strike(zg.gain, t, 0.3, 0.45, 0.004);
    chain(zap, rm, filter(ctx, "bandpass", 1300, 0.8), zg, wet);
    const crack = gain(ctx, 0);
    env(crack.gain, t, [
      [0, 0],
      [0.001, 0.6],
      [0.035, 0],
    ]);
    chain(noise(ctx, t, 0.05, r), filter(ctx, "highpass", 5000, 0.7), crack, wet);
    debris(ctx, wet, t, r, 8, 0.7, 0.08);
  },
};

/** A guarded hit: duller (low-passed) plate, short, with a bright tick on top. */
export const block: Recipe = {
  seconds: 0.3,
  render(ctx, out, r) {
    const t = 0.002;
    const lp = filter(ctx, "lowpass", 2000, 0.9);
    lp.connect(out);
    modes(ctx, lp, t, 720, BAR, [0.4, 0.3, 0.2, 0.1], [0.09, 0.07, 0.05, 0.04]);
    smack(ctx, lp, t, r, 900, 0.45, 0.04);
    thump(ctx, lp, t, 210, 95, 0.03, 0.55, 0.07);
    // The tick bypasses the low-pass so the parry reads instantly.
    const tick = gain(ctx, 0);
    strike(tick.gain, t, 0.35, 0.012, 0.0005);
    chain(osc(ctx, "square", 3400, t, 0.03), filter(ctx, "highpass", 2500, 0.7), tick, out);
    click(ctx, out, t, r, 0.4, 4000, 0.003);
  },
};

/**
 * Air cut by a beak: noise through two stacked band-passes sweeping up
 * together (4th order, so it reads as a "swish" and not as hiss).
 */
function whoosh(ctx: SynthContext, out: AudioNode, r: Rng, from: number, to: number, sweep: number, seconds: number, q: number, color: "white" | "pink", level = 1): void {
  const t = 0.002;
  const a = filter(ctx, "bandpass", from, q);
  const b = filter(ctx, "bandpass", from, q);
  glide(a.frequency, t, from, to, sweep);
  glide(b.frequency, t, from, to, sweep);
  const g = gain(ctx, 0);
  env(g.gain, t, [
    [0, 0],
    [sweep * 0.35, level],
    [sweep, level * 0.55],
    [seconds - 0.01, 0],
  ]);
  chain(noise(ctx, t, seconds, r, color), a, b, g, out);
}

export const whiffLight: Recipe = {
  seconds: 0.22,
  render(ctx, out, r) {
    whoosh(ctx, out, r, 450, 2400, 0.12, 0.21, 1.8, "white");
  },
};

export const whiffHeavy: Recipe = {
  seconds: 0.36,
  render(ctx, out, r) {
    whoosh(ctx, out, r, 260, 1500, 0.2, 0.35, 1.5, "pink");
    // Body: the low rush of a whole robot lunging.
    const g = gain(ctx, 0);
    env(g.gain, 0.002, [
      [0, 0],
      [0.08, 0.5],
      [0.34, 0],
    ]);
    chain(noise(ctx, 0.002, 0.36, r, "brown"), filter(ctx, "lowpass", 400, 0.7), g, out);
  },
};

/** Servo whine: a band-passed square gliding between two pitches. */
function servo(ctx: SynthContext, out: AudioNode, t: number, from: number, to: number, seconds: number, level: number): void {
  const o = osc(ctx, "square", from, t, seconds + 0.02);
  glide(o.frequency, t, from, to, seconds);
  const g = gain(ctx, 0);
  env(g.gain, t, [
    [0, 0],
    [0.015, level],
    [seconds * 0.6, level * 0.7],
    [seconds, 0],
  ]);
  chain(o, filter(ctx, "bandpass", (from + to) * 1.2, 1.6), g, out);
}

/** Dash: a quick servo zip over a whoosh, with a foot scuff at the start. */
export const dash: Recipe = {
  seconds: 0.26,
  render(ctx, out, r) {
    whoosh(ctx, out, r, 900, 3500, 0.1, 0.24, 1.6, "white", 0.6);
    servo(ctx, out, 0.004, 420, 900, 0.1, 0.4);
    click(ctx, out, 0.002, r, 0.25, 1500, 0.01);
  },
};

/** Jump: legs push off (soft thump), servos glide up, a little air. */
export const jump: Recipe = {
  seconds: 0.3,
  render(ctx, out, r) {
    thump(ctx, out, 0.002, 120, 70, 0.05, 0.6, 0.08);
    servo(ctx, out, 0.01, 260, 640, 0.17, 0.45);
    whoosh(ctx, out, r, 600, 1600, 0.12, 0.26, 1.4, "pink", 0.5);
  },
};

/** Land: a thud into dirt with a small clank of metal feet. */
export const land: Recipe = {
  seconds: 0.32,
  render(ctx, out, r) {
    const t = 0.002;
    thump(ctx, out, t, 130, 45, 0.07, 1, 0.2);
    const dust = gain(ctx, 0);
    strike(dust.gain, t, 0.45, 0.12, 0.002);
    chain(noise(ctx, t, 0.15, r, "pink"), filter(ctx, "lowpass", 900, 0.7), dust, out);
    modes(ctx, out, t + 0.004, 900, BAR.slice(0, 3), [0.14, 0.09, 0.05], [0.12, 0.08, 0.05], 0);
    click(ctx, out, t, r, 0.3, 2000);
  },
};

/** Ring-out: a cartoon falling whistle, then the robot lands in the scrap pile. */
export const ringout: Recipe = {
  seconds: 2.7,
  loudness: 0.14,
  render(ctx, out, r) {
    const fall = 1.0;
    const wet = withReverb(ctx, out, 1.3, 0.28, r, 0.45);
    const w = osc(ctx, "sine", 1500, 0.003, fall);
    glide(w.frequency, 0.003, 1500, 200, fall);
    const vib = gain(ctx, 18);
    osc(ctx, "sine", 6, 0.003, fall).connect(vib).connect(w.detune);
    const wg = gain(ctx, 0);
    env(wg.gain, 0.003, [
      [0, 0],
      [0.06, 0.4],
      [fall * 0.8, 0.4],
      [fall - 0.01, 0],
    ]);
    chain(w, wg, wet);

    const t = fall + 0.05;
    const bus = gain(ctx, 1);
    chain(bus, shaper(ctx, 3), wet);
    click(ctx, bus, t, r, 1, 1500, 0.01);
    crunch(ctx, bus, t, r, 0.7, 0.8);
    thump(ctx, bus, t, 130, 34, 0.1, 1, 0.5);
    boom(ctx, bus, t, r, 0.6, 0.9);
    // Several different pieces of scrap, struck a few ms apart.
    for (const [dt, base, lvl] of [
      [0, 310, 0.3],
      [0.035, 470, 0.22],
      [0.09, 205, 0.25],
      [0.16, 690, 0.14],
    ] as const) {
      modes(ctx, bus, t + dt, base * between(r, 0.95, 1.05), BAR, [lvl, lvl * 0.8, lvl * 0.5, lvl * 0.3], [0.6, 0.4, 0.25, 0.15], 0.003);
    }
    debris(ctx, wet, t + 0.05, r, 10, 0.9, 0.08);
  },
};
