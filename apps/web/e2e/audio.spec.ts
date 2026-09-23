import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { SOUND_NAMES } from "../src/game/audio/names";
import { watchProblems } from "./support/console";
import { fightCall, snap, stepTicks } from "./support/fight";

const CAP = (name: string) => fileURLToPath(new URL(`../../../docs/captures/phase-1/${name}`, import.meta.url));

type Win = {
  __cockfight: {
    audio?: Record<string, (...a: unknown[]) => unknown>;
    fight?: { ready(): boolean; setInput(p: number, m: number): void; B: Record<string, number> };
  };
};

function audioCall<T>(page: Page, fn: string): Promise<T> {
  return page.evaluate((name) => {
    const a = (window as unknown as Win).__cockfight.audio;
    if (!a) return null;
    return JSON.parse(JSON.stringify((a[name] as () => unknown)())) as unknown;
  }, fn) as Promise<T>;
}

function setInput(page: Page, player: 0 | 1, mask: number): Promise<void> {
  return page.evaluate(([p, m]) => (window as unknown as Win).__cockfight.fight?.setInput(p as number, m as number), [player, mask] as const);
}

/** Starts a 2P fight through the mode picker: the FIGHT click is the user gesture that unlocks audio. */
async function fightFromPicker(page: Page, seed: string): Promise<void> {
  await page.goto(`/play?manual=1&debug=1&seed=${seed}`);
  await expect(page.getByTestId("mode-picker")).toBeVisible();
  await page.getByRole("button", { name: /2 PLAYERS/ }).click();
  await page.getByTestId("fight-button").click();
  await expect(page.getByTestId("fight-screen")).toBeVisible();
  await page.waitForFunction(() => (window as unknown as Win).__cockfight.fight?.ready() === true, null, { timeout: 60_000 });
  await expect.poll(() => audioCall<string>(page, "state")).toBe("running");
  await expect.poll(() => audioCall<number>(page, "rendered"), { timeout: 20_000 }).toBe(SOUND_NAMES.length);
}

test.describe("audio", () => {
  test("the FIGHT click starts WebAudio, and a peck plays its hit and scream", async ({ page }) => {
    const problems = await watchProblems(page);
    const logs: string[] = [];
    page.on("console", (m) => {
      if (m.text().includes("[cockfight] audio")) logs.push(m.text());
    });
    await fightFromPicker(page, "e2e-audio");
    // The first-exchange sounds are ready long before the countdown ends.
    const first = await audioCall<number>(page, "firstHitsMs");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(1500);
    await expect.poll(() => logs.find((l) => /sounds ready in \d+ ms/.test(l)) ?? "").not.toBe("");
    test.info().annotations.push({ type: "audio", description: logs.join(" | ") });
    console.log(logs.join("\n"));

    await stepTicks(page, 181); // countdown: 3, 2, 1, FIGHT
    const B = await page.evaluate(() => (window as unknown as Win).__cockfight.fight?.B as Record<string, number>);
    await setInput(page, 0, B.R as number);
    for (let i = 0; i < 200; i++) {
      const s = await snap(page);
      if ((s.f[1]?.x ?? 0) - (s.f[0]?.x ?? 0) <= 1100) break;
      await stepTicks(page, 1);
    }
    await setInput(page, 0, 0);
    await setInput(page, 0, B.S as number);
    await stepTicks(page, 1);
    await setInput(page, 0, 0);
    for (let i = 0; i < 12 && (await snap(page)).f[1]!.hitKind === 0; i++) await stepTicks(page, 1);
    expect((await snap(page)).f[1]!.hitKind).toBe(1);
    await stepTicks(page, 2);

    const directed = await fightCall<string[]>(page, "sounds");
    expect(directed).toEqual(expect.arrayContaining(["countdown_tick", "fight", "round_bell", "whiff_light", "hit_light", "scream_light"]));
    // ...and the engine really started them (the director's list alone would pass with no audio attached).
    const played = await audioCall<string[]>(page, "played");
    expect(played).toEqual(expect.arrayContaining(["countdown_tick", "fight", "round_bell", "hit_light", "scream_light"]));
    expect(await audioCall<string>(page, "state")).toBe("running");

    expect(problems.errors).toEqual([]);
    expect(await problems.cspViolations()).toEqual([]);
  });

  test("every sound renders to a clean buffer in the browser (spectrogram capture)", async ({ page }) => {
    const problems = await watchProblems(page);
    await fightFromPicker(page, "e2e-audio-render");
    const stats = await page.evaluate((names) => {
      const a = (window as unknown as Win).__cockfight.audio as { buffer(n: string): AudioBuffer | null; source(n: string): string | null };
      return names.map((n) => {
        const b = a.buffer(n);
        if (!b) return { n, ok: false, seconds: 0, peak: 0, finite: false, source: null };
        const d = b.getChannelData(0);
        let peak = 0;
        let finite = true;
        for (let i = 0; i < d.length; i++) {
          const v = d[i] as number;
          if (!Number.isFinite(v)) finite = false;
          else peak = Math.max(peak, Math.abs(v));
        }
        return { n, ok: true, seconds: b.duration, peak, finite, source: a.source(n) };
      });
    }, [...SOUND_NAMES]);
    for (const s of stats) {
      expect(s.ok, s.n).toBe(true);
      expect(s.finite, s.n).toBe(true);
      expect(s.source, s.n).toBe("recipe");
      expect(s.seconds, s.n).toBeGreaterThan(0.05);
      expect(s.peak, `${s.n} is audible`).toBeGreaterThan(0.1);
      expect(s.peak, `${s.n} does not clip`).toBeLessThanOrEqual(0.9);
    }

    // A contact sheet of every sound's spectrogram (0-11 kHz, log magnitude), for review.
    await page.evaluate(drawSpectrograms, [...SOUND_NAMES]);
    await page.getByTestId("audio-spectrograms").screenshot({ path: CAP("audio-spectrograms.png") });
    expect(problems.errors).toEqual([]);
  });
});

/** Runs in the page: draws one small spectrogram per sound into a full-window canvas. */
function drawSpectrograms(names: string[]): void {
  const a = (window as unknown as Win).__cockfight.audio as { buffer(n: string): AudioBuffer | null };
  const cols = 5;
  const rows = Math.ceil(names.length / cols);
  const tw = 256;
  const th = 128;
  const canvas = document.createElement("canvas");
  canvas.dataset.testid = "audio-spectrograms";
  canvas.width = cols * tw;
  canvas.height = rows * th;
  canvas.style.cssText = "position:fixed;left:0;top:0;z-index:99999;background:#000";
  document.body.appendChild(canvas);
  const g = canvas.getContext("2d") as CanvasRenderingContext2D;
  g.fillStyle = "#000";
  g.fillRect(0, 0, canvas.width, canvas.height);
  const N = 512;
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const fft = () => {
    for (let i = 1, j = 0; i < N; i++) {
      let bit = N >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        [re[i], re[j]] = [re[j] as number, re[i] as number];
        [im[i], im[j]] = [im[j] as number, im[i] as number];
      }
    }
    for (let len = 2; len <= N; len <<= 1) {
      const ang = (-2 * Math.PI) / len;
      for (let i = 0; i < N; i += len) {
        for (let k = 0; k < len / 2; k++) {
          const wr = Math.cos(ang * k);
          const wi = Math.sin(ang * k);
          const ar = re[i + k + len / 2] as number;
          const ai = im[i + k + len / 2] as number;
          const xr = ar * wr - ai * wi;
          const xi = ar * wi + ai * wr;
          re[i + k + len / 2] = (re[i + k] as number) - xr;
          im[i + k + len / 2] = (im[i + k] as number) - xi;
          re[i + k] = (re[i + k] as number) + xr;
          im[i + k] = (im[i + k] as number) + xi;
        }
      }
    }
  };
  const color = (v: number): [number, number, number] => {
    // 0..1 -> black, purple, orange, yellow, white
    const t = Math.max(0, Math.min(1, v));
    if (t < 0.33) return [Math.round(t * 3 * 120), 0, Math.round(t * 3 * 140)];
    if (t < 0.66) return [120 + Math.round((t - 0.33) * 3 * 135), Math.round((t - 0.33) * 3 * 120), 140 - Math.round((t - 0.33) * 3 * 140)];
    return [255, 120 + Math.round((t - 0.66) * 3 * 135), Math.round((t - 0.66) * 3 * 200)];
  };
  names.forEach((name, idx) => {
    const buf = a.buffer(name);
    const ox = (idx % cols) * tw;
    const oy = Math.floor(idx / cols) * th;
    if (!buf) return;
    const d = buf.getChannelData(0);
    const img = g.createImageData(tw, th - 14);
    const maxBin = Math.floor(((11000 / buf.sampleRate) * N) | 0);
    for (let x = 0; x < tw; x++) {
      const start = Math.floor((x / tw) * Math.max(1, d.length - N));
      for (let i = 0; i < N; i++) {
        const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
        re[i] = ((d[start + i] as number) || 0) * w;
        im[i] = 0;
      }
      fft();
      for (let y = 0; y < th - 14; y++) {
        const bin = Math.floor(((th - 15 - y) / (th - 15)) * maxBin);
        const mag = Math.hypot(re[bin] as number, im[bin] as number) / (N / 4);
        const db = 20 * Math.log10(mag + 1e-9);
        const [r, gg, b] = color((db + 80) / 80);
        const p = (y * tw + x) * 4;
        img.data[p] = r;
        img.data[p + 1] = gg;
        img.data[p + 2] = b;
        img.data[p + 3] = 255;
      }
    }
    g.putImageData(img, ox, oy + 14);
    g.fillStyle = "#ddd";
    g.font = "11px monospace";
    g.fillText(`${name} ${buf.duration.toFixed(2)}s`, ox + 3, oy + 11);
    g.strokeStyle = "#333";
    g.strokeRect(ox + 0.5, oy + 0.5, tw - 1, th - 1);
  });
}
