/**
 * Building blocks for the procedural recipes. A recipe is a pure function of a
 * `SynthContext` (an OfflineAudioContext in the browser, a recording fake in
 * unit tests): it builds a node graph and schedules it; nothing here plays.
 * Adapted from soltendogs `src/lib/audio/synth.ts` (rng, noise, env).
 */

/** The slice of BaseAudioContext a recipe may use. */
export type SynthContext = Pick<
  BaseAudioContext,
  | "sampleRate"
  | "createOscillator"
  | "createGain"
  | "createBiquadFilter"
  | "createBufferSource"
  | "createBuffer"
  | "createWaveShaper"
  | "createConvolver"
>;

export type Rng = () => number;

export interface Recipe {
  /** Buffer length in seconds (for a loop, its period). */
  seconds: number;
  /**
   * Loops only: seconds rendered past the period and cross-faded onto the
   * head, so the seam is as smooth as the rest of the loop.
   */
  loopTail?: number;
  /**
   * Loudness (weighted 400 ms RMS, see dsp.ts) a sustained sound is
   * normalised to; default 0.1. The knob for "this one is bigger": the KO
   * horn and roar sit above the rest of the mix. Short hits are peak-limited
   * before they reach it.
   */
  loudness?: number;
  render(ctx: SynthContext, out: AudioNode, r: Rng): void;
}

/** mulberry32: tiny, fast, good enough for noise and scatter. */
export function rng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform in [lo, hi). */
export const between = (r: Rng, lo: number, hi: number) => lo + (hi - lo) * r();

export type NoiseColor = "white" | "pink" | "brown";

/** A mono noise buffer. Pink (-3 dB/oct) reads as crowd and air; brown (-6 dB/oct) as rumble. */
export function noiseBuffer(ctx: SynthContext, seconds: number, r: Rng, color: NoiseColor = "white"): AudioBuffer {
  const n = Math.max(1, Math.ceil(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b0 = 0,
    b1 = 0,
    b2 = 0,
    last = 0;
  for (let i = 0; i < n; i++) {
    const w = r() * 2 - 1;
    if (color === "white") d[i] = w;
    else if (color === "pink") {
      // Paul Kellet's economy pink filter.
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.25;
    } else {
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    }
  }
  return buf;
}

/** A started noise source, [t, t + seconds). */
export function noise(ctx: SynthContext, t: number, seconds: number, r: Rng, color: NoiseColor = "white"): AudioBufferSourceNode {
  const s = ctx.createBufferSource();
  s.buffer = noiseBuffer(ctx, seconds, r, color);
  s.start(t);
  return s;
}

/** A started oscillator, [t, t + seconds). */
export function osc(ctx: SynthContext, type: OscillatorType, freq: number, t: number, seconds: number): OscillatorNode {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  o.start(t);
  o.stop(t + seconds);
  return o;
}

export function gain(ctx: SynthContext, v: number): GainNode {
  const g = ctx.createGain();
  g.gain.value = v;
  return g;
}

export function filter(ctx: SynthContext, type: BiquadFilterType, freq: number, q = 0.707): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  return f;
}

/** Connects nodes in series; returns the last one. */
export function chain(...nodes: AudioNode[]): AudioNode {
  for (let i = 1; i < nodes.length; i++) (nodes[i - 1] as AudioNode).connect(nodes[i] as AudioNode);
  return nodes[nodes.length - 1] as AudioNode;
}

/** Linear breakpoints [dt, value] relative to t0. */
export function env(param: AudioParam, t0: number, points: readonly (readonly [number, number])[]): void {
  const [first, ...rest] = points;
  if (!first) return;
  param.setValueAtTime(first[1], t0 + first[0]);
  for (const [dt, v] of rest) param.linearRampToValueAtTime(v, t0 + dt);
}

/**
 * Percussive envelope: 0 -> peak in `attack`, then an exponential fall of
 * 60 dB over `decay` (what a struck object does).
 */
export function strike(param: AudioParam, t: number, peak: number, decay: number, attack = 0.0015): void {
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(peak, t + attack);
  param.exponentialRampToValueAtTime(peak * 0.001, t + attack + decay);
  param.linearRampToValueAtTime(0, t + attack + decay + 0.005);
}

/** Exponential glide from -> to over [t, t + seconds] (pitch and cutoff sweeps). */
export function glide(param: AudioParam, t: number, from: number, to: number, seconds: number): void {
  param.setValueAtTime(from, t);
  param.exponentialRampToValueAtTime(to, t + seconds);
}

/** tanh soft clipper; `drive` 1 is gentle, 6+ is crunch. Unity at full scale. */
export function shaper(ctx: SynthContext, drive: number): WaveShaperNode {
  const n = 2048;
  const curve = new Float32Array(n);
  const norm = Math.tanh(drive);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(drive * x) / norm;
  }
  const w = ctx.createWaveShaper();
  w.curve = curve;
  w.oversample = "2x";
  return w;
}

/**
 * A small-room convolution reverb baked into a sound (free at play time):
 * a few early reflections, then noise decaying 60 dB over `seconds`, getting
 * darker as it goes (like a junkyard of corrugated metal, not a cathedral).
 */
export function reverb(ctx: SynthContext, seconds: number, r: Rng, brightness = 0.5): ConvolverNode {
  const sr = ctx.sampleRate;
  const n = Math.ceil(sr * seconds);
  const buf = ctx.createBuffer(1, n, sr);
  const d = buf.getChannelData(0);
  const k = Math.log(1000) / n;
  let lp = 0;
  for (let i = 0; i < n; i++) {
    // One-pole low-pass whose cutoff falls over the tail.
    const a = brightness * (1 - (0.85 * i) / n);
    lp += a * (r() * 2 - 1 - lp);
    d[i] = lp * Math.exp(-k * i);
  }
  for (let e = 0; e < 6; e++) {
    const at = Math.floor(sr * between(r, 0.007, 0.045));
    d[at] = (d[at] ?? 0) + (r() < 0.5 ? -1 : 1) * between(r, 0.3, 0.7);
  }
  const c = ctx.createConvolver();
  c.buffer = buf;
  return c;
}

/** Dry + wet into `out`; returns the input node to connect a sound into. */
export function withReverb(ctx: SynthContext, out: AudioNode, seconds: number, wet: number, r: Rng, brightness = 0.5): AudioNode {
  const input = gain(ctx, 1);
  input.connect(out);
  const send = gain(ctx, wet);
  chain(input, send, reverb(ctx, seconds, r, brightness), out);
  return input;
}

/**
 * Modal (struck-bar) synthesis: sine partials at `ratios` of `base`, each
 * with its own decay, plus a slightly detuned twin on the lower modes so they
 * beat like real metal instead of ringing like a glockenspiel.
 */
export function modes(
  ctx: SynthContext,
  out: AudioNode,
  t: number,
  base: number,
  ratios: readonly number[],
  amps: readonly number[],
  decays: readonly number[],
  beat = 0.004,
): void {
  const nyquist = ctx.sampleRate / 2;
  for (let i = 0; i < ratios.length; i++) {
    const f = base * (ratios[i] as number);
    if (f >= nyquist * 0.9) continue;
    const a = amps[i] ?? 0.2;
    const dec = decays[i] ?? 0.1;
    const twins = i < 2 && beat > 0 ? 2 : 1;
    for (let j = 0; j < twins; j++) {
      const g = gain(ctx, 0);
      strike(g.gain, t, a / twins, dec);
      chain(osc(ctx, "sine", f * (1 + j * beat), t, dec + 0.02), g, out);
    }
  }
}

/** A short high-passed noise tick: the contact transient of any hit. */
export function click(ctx: SynthContext, out: AudioNode, t: number, r: Rng, level: number, hp = 2500, len = 0.004): void {
  const g = gain(ctx, 0);
  env(g.gain, t, [
    [0, 0],
    [0.0005, level],
    [len, 0],
  ]);
  chain(noise(ctx, t, len + 0.01, r), filter(ctx, "highpass", hp, 0.8), g, out);
}

/** Sine kick: pitch falls from -> to while the body decays. */
export function thump(ctx: SynthContext, out: AudioNode, t: number, from: number, to: number, fall: number, level: number, decay: number): void {
  const o = osc(ctx, "sine", from, t, decay + 0.03);
  glide(o.frequency, t, from, to, fall);
  const g = gain(ctx, 0);
  strike(g.gain, t, level, decay, 0.002);
  chain(o, g, out);
}
