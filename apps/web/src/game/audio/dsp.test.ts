import { describe, expect, it } from "vitest";
import { fadeOut, loopCrossfade, loudness, measure, normalize } from "./dsp";
import { rng } from "./synth";

const SR = 44100;

function sine(seconds: number, freq: number, amp: number): Float32Array {
  const d = new Float32Array(Math.round(SR * seconds));
  for (let i = 0; i < d.length; i++) d[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return d;
}

function noise(n: number, seed: number): Float32Array {
  const r = rng(seed);
  const d = new Float32Array(n);
  for (let i = 0; i < n; i++) d[i] = r() * 2 - 1;
  return d;
}

describe("dsp", () => {
  it("measure finds the peak and flags non-finite samples", () => {
    const d = new Float32Array([0, 0.5, -0.8, 0.2]);
    expect(measure(d, 2).peak).toBeCloseTo(0.8);
    d[1] = NaN;
    expect(measure(d, 2).finite).toBe(false);
  });

  it("a short transient is peak-normalised", () => {
    const d = new Float32Array(SR / 2);
    for (let i = 0; i < 200; i++) d[i] = 0.3 * Math.sin(i * 0.3) * (1 - i / 200);
    normalize(d, SR);
    expect(measure(d, 1).peak).toBeCloseTo(0.89, 3);
  });

  it("a sustained tone is loudness-limited below full peak", () => {
    const d = sine(1.5, 1000, 0.5);
    normalize(d, SR, 0.89, 0.1);
    expect(measure(d, 1).peak).toBeLessThan(0.3);
    expect(loudness(d, SR)).toBeCloseTo(0.1, 3);
  });

  it("the loudness weighting ignores sub-bass: a 50 Hz boom is not 'loud'", () => {
    expect(loudness(sine(1, 50, 0.5), SR)).toBeLessThan(loudness(sine(1, 1000, 0.5), SR) / 5);
  });

  it("a short blip counts as a burst in a 400 ms window, not as its own length", () => {
    expect(loudness(sine(0.08, 1000, 0.5), SR)).toBeLessThan(loudness(sine(0.4, 1000, 0.5), SR) * 0.6);
  });

  it("normalize zeroes NaNs and leaves silence alone", () => {
    const d = new Float32Array([0.1, NaN, -0.2, Infinity]);
    normalize(d, SR);
    expect(measure(d, 1).finite).toBe(true);
    const z = new Float32Array(100);
    expect(normalize(z, SR)).toBe(1);
  });

  it("loopCrossfade makes the seam continuous and leaves the rest untouched", () => {
    const period = 8000;
    const tail = 1000;
    const orig = noise(period + tail, 7);
    const d = orig.slice();
    const loop = loopCrossfade(d, period);
    expect(loop.length).toBe(period);
    // Wrapping from the last sample to the first continues the rendered signal.
    expect(Math.abs((loop[0] as number) - (orig[period] as number))).toBeLessThan(0.01);
    expect(loop[period - 1]).toBe(orig[period - 1]);
    for (let i = tail; i < period; i += 97) expect(loop[i]).toBe(orig[i]);
    // Equal-power: mid-fade energy of uncorrelated noise stays ~constant.
    let e = 0;
    for (let i = 400; i < 600; i++) e += (loop[i] as number) ** 2;
    let e0 = 0;
    for (let i = 4000; i < 4200; i++) e0 += (loop[i] as number) ** 2;
    expect(e / e0).toBeGreaterThan(0.6);
    expect(e / e0).toBeLessThan(1.6);
  });

  it("fadeOut ends on silence", () => {
    const d = new Float32Array(1000).fill(0.5);
    fadeOut(d, 100);
    expect(d[999]).toBe(0);
    expect(d[899]).toBe(0.5);
    expect(d[950] as number).toBeLessThan(0.5);
  });
});
