/**
 * The junkyard crowd (renderJuice.md §6). Band-passed noise with slow AM is
 * the bed (chest, vowel and hiss), but on its own that reads as surf. What
 * makes it people is a crowd of little voices on top: saws with their own
 * pitch arcs through shared vowel formant banks ("ah", "eh", "oh", "ay"),
 * plus whistles and claps. The loop is rendered with a tail that offline.ts
 * cross-fades onto its head, so it repeats seamlessly; the live engine maps
 * hype onto its level and brightness.
 */
import { between, chain, env, filter, gain, noiseBuffer, osc, type Recipe, type Rng, type SynthContext } from "../synth";

/** [F1, F2] Hz of the vowels a crowd shouts on. */
const VOWELS: readonly (readonly [number, number])[] = [
  [730, 1090], // ah
  [530, 1840], // eh
  [570, 840], // oh
  [660, 1720], // ay ("hey")
];

/**
 * One formant bank per vowel; voices feed a bank's input. Sharing the
 * filters keeps a 100-voice crowd at two nodes per voice.
 */
function vowelBanks(ctx: SynthContext, out: AudioNode): AudioNode[] {
  return VOWELS.map(([f1, f2]) => {
    const input = gain(ctx, 1);
    chain(input, filter(ctx, "bandpass", f1, 2.5), gain(ctx, 1), out);
    chain(input, filter(ctx, "bandpass", f2, 4), gain(ctx, 0.7), out);
    chain(input, filter(ctx, "bandpass", 2700, 4), gain(ctx, 0.3), out);
    return input;
  });
}

interface VoiceSpread {
  count: number;
  /** Fundamental range, Hz. */
  pitch: readonly [number, number];
  /** Length range, seconds. */
  len: readonly [number, number];
  /** Pitch multiplier reached 40% of the way in ("ooOOH" > 1). */
  lift: readonly [number, number];
  level: number;
  /** Indices into VOWELS the voices choose from. */
  vowels: readonly number[];
  /** Chatter in syllables rather than hold one note. */
  talk: boolean;
}

function voices(ctx: SynthContext, banks: AudioNode[], t0: number, span: number, r: Rng, v: VoiceSpread): void {
  for (let i = 0; i < v.count; i++) {
    const len = between(r, v.len[0], v.len[1]);
    const t = t0 + between(r, 0, Math.max(0.01, span - len));
    const f = between(r, v.pitch[0], v.pitch[1]);
    const lift = between(r, v.lift[0], v.lift[1]);
    const lvl = v.level * between(r, 0.4, 1);
    const saw = osc(ctx, "sawtooth", f, t, len + 0.02);
    const g = gain(ctx, 0);
    const a = Math.min(0.12, len * 0.25);
    // Talkers: ~4 syllables a second, each its own pitch and a dip between
    // them. Without this a murmur is a choir holding a chord.
    const syl = v.talk ? Math.max(1, Math.round(len * 4)) : 1;
    saw.frequency.setValueAtTime(f, t);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(lvl, t + a);
    for (let k = 1; k <= syl; k++) {
      const x = k / syl;
      const arc = x < 0.4 ? 1 + (lift - 1) * (x / 0.4) : lift - (lift - (lift > 1.05 ? lift * 0.85 : 0.92)) * ((x - 0.4) / 0.6);
      const at = t + len * x;
      saw.frequency.linearRampToValueAtTime(f * arc * (syl > 1 ? between(r, 0.93, 1.07) : 1), at);
      if (syl > 1 && k < syl) {
        g.gain.linearRampToValueAtTime(lvl * between(r, 0.25, 0.5), Math.max(t + a, at - len / syl / 2));
        g.gain.linearRampToValueAtTime(lvl * between(r, 0.7, 1), at);
      }
    }
    if (syl === 1) g.gain.linearRampToValueAtTime(lvl * 0.8, t + Math.max(a + 0.01, len * 0.7));
    g.gain.linearRampToValueAtTime(0, t + len);
    const bank = banks[v.vowels[Math.floor(r() * v.vowels.length)] ?? 0] as AudioNode;
    chain(saw, g, bank);
  }
}

/** Band-passed pink noise with slow swells (whole cycles per 8 s, so the loop's AM repeats cleanly). */
function bed(ctx: SynthContext, out: AudioNode, t: number, seconds: number, r: Rng, level: number, bright: number): void {
  const n = noiseBuffer(ctx, seconds, r, "pink");
  const bands: readonly (readonly [number, number, number, number])[] = [
    // [Hz, Q, level, swell Hz]
    [320, 0.8, 1, 0.25],
    [950, 1.1, 0.9, 0.375],
    [2600, 1.3, 0.3 + 0.5 * bright, 0.625],
  ];
  for (const [f, q, l, swell] of bands) {
    const g = gain(ctx, level * l);
    osc(ctx, "sine", swell, t, seconds).connect(gain(ctx, level * l * 0.35)).connect(g.gain);
    const s = ctx.createBufferSource();
    s.buffer = n;
    s.start(t);
    chain(s, filter(ctx, "bandpass", f, q), g, out);
  }
}

/**
 * Claps and stomps written straight into one buffer (a few hundred tiny
 * bursts would otherwise be a few hundred nodes).
 */
function claps(ctx: SynthContext, out: AudioNode, t: number, seconds: number, r: Rng, count: number, level: number, fade: (x: number) => number): void {
  const sr = ctx.sampleRate;
  const buf = ctx.createBuffer(1, Math.ceil(sr * seconds), sr);
  const d = buf.getChannelData(0);
  const burst = Math.round(sr * 0.012);
  for (let c = 0; c < count; c++) {
    const at = Math.floor(r() * (d.length - burst));
    const amp = level * between(r, 0.25, 1) * fade(at / d.length);
    for (let i = 0; i < burst; i++) d[at + i] = (d[at + i] as number) + (r() * 2 - 1) * amp * Math.exp(-i / (burst * 0.25));
  }
  const s = ctx.createBufferSource();
  s.buffer = buf;
  s.start(t);
  chain(s, filter(ctx, "bandpass", 1500, 0.7), out);
}

/** Two-finger whistle: a bright sine that jumps up and falls back. */
function whistle(ctx: SynthContext, out: AudioNode, t: number, r: Rng, level: number): void {
  const f = between(r, 2300, 2900);
  const o = osc(ctx, "sine", f, t, 0.75);
  env(o.frequency, t, [
    [0, f * 0.85],
    [0.08, f * 1.12],
    [0.45, f * 1.1],
    [0.7, f * 0.9],
  ]);
  const g = gain(ctx, 0);
  env(g.gain, t, [
    [0, 0],
    [0.05, level],
    [0.5, level * 0.8],
    [0.7, 0],
  ]);
  chain(o, g, out);
}

const flat = () => 1;

/** 8 s of arena murmur that loops (hype shapes it live). */
export const crowdLoop: Recipe = {
  seconds: 8,
  loopTail: 1,
  render(ctx, out, r) {
    const span = 9;
    bed(ctx, out, 0, span, r, 0.16, 0.3);
    const banks = vowelBanks(ctx, out);
    // Murmur: ~10 voices at any moment, men and women, mostly flat.
    voices(ctx, banks, 0, span, r, { count: 90, pitch: [100, 260], len: [0.5, 1.6], lift: [0.95, 1.12], level: 0.16, vowels: [0, 1, 2, 3], talk: true });
    // The odd shout.
    voices(ctx, banks, 0, span, r, { count: 10, pitch: [230, 400], len: [0.25, 0.6], lift: [1.1, 1.35], level: 0.22, vowels: [0, 3], talk: false });
    claps(ctx, out, 0, span, r, 70, 0.12, flat);
    whistle(ctx, out, between(r, 1.5, 3), r, 0.03);
    whistle(ctx, out, between(r, 5, 7), r, 0.025);
  },
};

/** "Ooooh!": the crowd rising as a meter fills. */
export const crowdSwell: Recipe = {
  seconds: 2.4,
  render(ctx, out, r) {
    const d = 2.35;
    const g = gain(ctx, 0);
    env(g.gain, 0, [
      [0, 0],
      [0.8, 1],
      [1.4, 0.9],
      [d, 0],
    ]);
    const lp = filter(ctx, "lowpass", 900, 0.7);
    env(lp.frequency, 0, [
      [0, 900],
      [0.9, 5000],
    ]);
    chain(lp, g, out);
    bed(ctx, lp, 0, d, r, 0.14, 0.5);
    const banks = vowelBanks(ctx, lp);
    voices(ctx, banks, 0, 0.5, r, { count: 36, pitch: [110, 300], len: [1.3, 1.85], lift: [1.2, 1.45], level: 0.2, vowels: [2, 0], talk: false });
  },
};

/** The big one after a KO or ring-out: fast rise, "YEAH!"s, whistles, applause. */
export const crowdRoar: Recipe = {
  seconds: 3.6,
  loudness: 0.15,
  render(ctx, out, r) {
    const d = 3.55;
    const g = gain(ctx, 0);
    env(g.gain, 0, [
      [0, 0],
      [0.15, 1],
      [1.4, 0.85],
      [d, 0],
    ]);
    g.connect(out);
    bed(ctx, g, 0, d, r, 0.18, 1);
    const banks = vowelBanks(ctx, g);
    voices(ctx, banks, 0, 0.35, r, { count: 40, pitch: [150, 380], len: [1.2, 2.6], lift: [1.15, 1.4], level: 0.2, vowels: [0, 3, 1], talk: false });
    voices(ctx, banks, 0.3, 2.8, r, { count: 45, pitch: [180, 420], len: [0.3, 0.9], lift: [1.1, 1.4], level: 0.16, vowels: [0, 3], talk: true });
    claps(ctx, g, 0.2, 3.2, r, 420, 0.25, (x) => 1 - 0.6 * x);
    whistle(ctx, g, 0.25, r, 0.06);
    whistle(ctx, g, 0.9, r, 0.05);
    whistle(ctx, g, 1.6, r, 0.045);
  },
};
