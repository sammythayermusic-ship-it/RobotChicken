/**
 * Post-processing of rendered sounds: plain math on Float32Arrays, no
 * WebAudio, so it is unit-tested in node.
 */

export interface Level {
  /** Largest |sample|. */
  peak: number;
  /** Loudest RMS over any window (hop = half a window). */
  rms: number;
  /** False if any sample is NaN or infinite. */
  finite: boolean;
}

export function measure(d: Float32Array, win: number): Level {
  let peak = 0;
  let finite = true;
  for (let i = 0; i < d.length; i++) {
    const v = d[i] as number;
    if (!Number.isFinite(v)) finite = false;
    else if (Math.abs(v) > peak) peak = Math.abs(v);
  }
  const w = Math.max(1, Math.min(win, d.length));
  const hop = Math.max(1, w >> 1);
  let rms = 0;
  for (let s = 0; s + w <= d.length; s += hop) {
    let sum = 0;
    for (let i = s; i < s + w; i++) {
      const v = d[i] as number;
      if (Number.isFinite(v)) sum += v * v;
    }
    rms = Math.max(rms, Math.sqrt(sum / w));
  }
  return { peak, rms, finite };
}

/** RBJ-cookbook biquad, applied into a new array. */
function biquad(x: Float32Array, sampleRate: number, type: "highpass" | "highshelf", f0: number, q: number, dbGain = 0): Float32Array {
  const w = (2 * Math.PI * f0) / sampleRate;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
  if (type === "highpass") {
    b0 = (1 + cos) / 2;
    b1 = -(1 + cos);
    b2 = (1 + cos) / 2;
    a0 = 1 + alpha;
    a1 = -2 * cos;
    a2 = 1 - alpha;
  } else {
    const A = Math.pow(10, dbGain / 40);
    const s = 2 * Math.sqrt(A) * alpha;
    b0 = A * (A + 1 + (A - 1) * cos + s);
    b1 = -2 * A * (A - 1 + (A + 1) * cos);
    b2 = A * (A + 1 + (A - 1) * cos - s);
    a0 = A + 1 - (A - 1) * cos + s;
    a1 = 2 * (A - 1 - (A + 1) * cos);
    a2 = A + 1 - (A - 1) * cos - s;
  }
  const y = new Float32Array(x.length);
  let x1 = 0,
    x2 = 0,
    y1 = 0,
    y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i] as number;
    const yi = (b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1;
    x1 = xi;
    y2 = y1;
    y1 = yi;
    y[i] = yi;
  }
  return y;
}

/**
 * Loudness weighting for the speakers most players have (phones, laptops):
 * K-weighting's +4 dB presence shelf, and a 2nd-order high-pass at 150 Hz
 * instead of K's 38 Hz, because those speakers barely reproduce the sub
 * thumps. Without it a slam's boom would "use up" its level and leave the
 * audible crack quiet.
 */
export function weighted(d: Float32Array, sampleRate: number): Float32Array {
  const x = new Float32Array(d.length);
  for (let i = 0; i < d.length; i++) {
    const v = d[i] as number;
    x[i] = Number.isFinite(v) ? v : 0;
  }
  return biquad(biquad(x, sampleRate, "highshelf", 1682, 0.7071, 4), sampleRate, "highpass", 150, 0.7071);
}

/** Loudness window: EBU R128 "momentary" (400 ms), close to how long the ear integrates a burst. */
export const LOUDNESS_WINDOW = 0.4;

/**
 * Loudest weighted RMS over any 400 ms window. The window never shrinks: a
 * 80 ms blip is measured as 80 ms of sound and 320 ms of silence, as heard.
 */
export function loudness(d: Float32Array, sampleRate: number): number {
  const x = weighted(d, sampleRate);
  const w = Math.max(1, Math.round(sampleRate * LOUDNESS_WINDOW));
  const hop = Math.max(1, w >> 2);
  const sq = new Float64Array(x.length + 1);
  for (let i = 0; i < x.length; i++) sq[i + 1] = (sq[i] as number) + (x[i] as number) * (x[i] as number);
  let best = 0;
  for (let s = 0; s < x.length; s += hop) best = Math.max(best, (sq[Math.min(x.length, s + w)] as number) - (sq[s] as number));
  return Math.sqrt(best / w);
}

/**
 * Scales in place so the sound peaks at `peak`, unless that would make its
 * loudest 400 ms (weighted, see weighted()) louder than `target` RMS.
 * Short hits end up peak-limited and sustained sounds (horn, bell, crowd)
 * loudness-limited, so the SOUND_SPECS gains compare like with like.
 * Non-finite samples become 0. Returns the gain applied.
 */
export function normalize(d: Float32Array, sampleRate: number, peak = 0.89, target = 0.1): number {
  const lv = measure(d, 1);
  if (!lv.finite) for (let i = 0; i < d.length; i++) if (!Number.isFinite(d[i] as number)) d[i] = 0;
  if (lv.peak <= 1e-6) return 1;
  const loud = loudness(d, sampleRate);
  const g = Math.min(peak / lv.peak, loud > 0 ? target / loud : Infinity);
  for (let i = 0; i < d.length; i++) d[i] = (d[i] as number) * g;
  return g;
}

/**
 * Seamless loop: `d` holds `period` samples plus a rendered tail. The tail is
 * mixed over the head with equal-power fades (the layers are uncorrelated
 * noise), so the last sample of the period flows into what was rendered right
 * after it. Returns the first `period` samples (a view into `d`).
 */
export function loopCrossfade<B extends ArrayBufferLike>(d: Float32Array<B>, period: number): Float32Array<B> {
  const fade = Math.min(d.length - period, period);
  for (let i = 0; i < fade; i++) {
    const a = ((i + 0.5) / fade) * (Math.PI / 2);
    d[i] = (d[i] as number) * Math.sin(a) + (d[period + i] as number) * Math.cos(a);
  }
  return d.subarray(0, period);
}

/** Linear fade over the last `samples`, so a sound cut by its buffer length never clicks. */
export function fadeOut(d: Float32Array, samples: number): void {
  const n = Math.min(samples, d.length);
  for (let i = 0; i < n; i++) {
    const k = d.length - n + i;
    d[k] = (d[k] as number) * (1 - (i + 1) / n);
  }
}
