import { describe, expect, it } from "vitest";
import { SOUND_NAMES, SOUND_SPECS } from "./names";
import { VoicePool, mix32, pitchRate } from "./voices";

describe("VoicePool", () => {
  it("fills free slots before stealing", () => {
    const p = new VoicePool(3);
    expect([p.acquire(), p.acquire(), p.acquire()]).toEqual([0, 1, 2]);
    expect(p.stole).toBe(false);
    expect(p.active).toBe(3);
  });

  it("steals the voice that started first", () => {
    const p = new VoicePool(3);
    p.acquire(); // slot 0, oldest
    p.acquire(); // 1
    p.acquire(); // 2
    expect(p.acquire()).toBe(0);
    expect(p.stole).toBe(true);
    // Slot 0 is now the newest, so slot 1 goes next, then 2.
    expect(p.acquire()).toBe(1);
    expect(p.acquire()).toBe(2);
    expect(p.acquire()).toBe(0);
    expect(p.active).toBe(3);
  });

  it("reuses a released slot without stealing", () => {
    const p = new VoicePool(2);
    p.acquire();
    p.acquire();
    p.release(0);
    expect(p.busy(0)).toBe(false);
    expect(p.acquire()).toBe(0);
    expect(p.stole).toBe(false);
    // Oldest is now slot 1 even though slot 0 has the lower index.
    expect(p.acquire()).toBe(1);
    expect(p.stole).toBe(true);
  });

  it("a single-voice sound always restarts in its one slot", () => {
    const p = new VoicePool(1);
    expect(p.acquire()).toBe(0);
    expect(p.acquire()).toBe(0);
    expect(p.stole).toBe(true);
  });

  it("ignores out-of-range releases and clamps capacity to at least 1", () => {
    const p = new VoicePool(0);
    expect(p.capacity).toBe(1);
    p.release(-1);
    p.release(5);
    expect(p.active).toBe(0);
  });

  it("every spec asks for at least one voice", () => {
    for (const n of SOUND_NAMES) expect(SOUND_SPECS[n].maxVoices, n).toBeGreaterThanOrEqual(1);
  });
});

describe("pitch jitter", () => {
  it("is deterministic per seed, so replays sound identical", () => {
    for (let seed = 0; seed < 50; seed++) expect(pitchRate(0.05, seed * 7919, 3)).toBe(pitchRate(0.05, seed * 7919, 3));
  });

  it("stays within +-pitchJitter and uses the whole range", () => {
    for (const n of SOUND_NAMES) {
      const j = SOUND_SPECS[n].pitchJitter;
      let lo = Infinity;
      let hi = -Infinity;
      for (let seed = 0; seed < 2000; seed++) {
        const r = pitchRate(j, Math.imul(seed, 0x9e3779b1) >>> 0, SOUND_NAMES.indexOf(n));
        lo = Math.min(lo, r);
        hi = Math.max(hi, r);
        expect(r).toBeGreaterThanOrEqual(1 - j);
        expect(r).toBeLessThanOrEqual(1 + j);
      }
      if (j > 0) {
        expect(lo, n).toBeLessThan(1 - j * 0.9);
        expect(hi, n).toBeGreaterThan(1 + j * 0.9);
      } else expect([lo, hi]).toEqual([1, 1]);
    }
  });

  it("is centred on 1", () => {
    let sum = 0;
    for (let seed = 0; seed < 5000; seed++) sum += pitchRate(0.1, seed, 0);
    expect(Math.abs(sum / 5000 - 1)).toBeLessThan(0.005);
  });

  it("decorrelates sounds fired by the same event (a hit and its scream)", () => {
    let same = 0;
    for (let seed = 0; seed < 500; seed++) if (Math.sign(pitchRate(0.05, seed, 0) - 1) === Math.sign(pitchRate(0.05, seed, 7) - 1)) same++;
    expect(same).toBeGreaterThan(180);
    expect(same).toBeLessThan(320);
  });

  it("mix32 is a 32-bit unsigned hash", () => {
    for (let i = 0; i < 100; i++) {
      const h = mix32(i, i * 3);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(2 ** 32);
    }
    expect(mix32(1, 2)).not.toBe(mix32(2, 1));
  });
});
