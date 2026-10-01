/**
 * The launch-video capture rig. Headed Chromium on the Mac's GPU, one PNG per
 * sim tick for fights (the sim only advances through __cockfight.fight, so
 * every frame is exact and slow-motion is free), stills and short live
 * captures for site pages. Frames are encoded to a high-quality intermediate
 * per shot; the edit (build.ts) cuts from those. See docs/plan-videos.md.
 */
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

export const TICK_MS = 1000 / 60;

export interface Viewport {
  width: number;
  height: number;
  /** Phone shots: mobile emulation with touch controls. */
  mobile?: boolean;
  deviceScaleFactor?: number;
}
/** Fights are shot at 2× (3840×2160) so the edit can punch in and stay sharp. */
export const DESKTOP: Viewport = { width: 1920, height: 1080, deviceScaleFactor: 2 };
export const DESKTOP_1X: Viewport = { width: 1920, height: 1080 };
export const PHONE: Viewport = { width: 390, height: 844, mobile: true, deviceScaleFactor: 3 };
/** A phone held sideways (the fight fills the screen, buttons in the corners). */
export const PHONE_LANDSCAPE: Viewport = { width: 844, height: 390, mobile: true, deviceScaleFactor: 3 };

/** Window-side view of the sim for the scripts (a subset; see packages/sim/src/state.ts). */
export interface FighterView {
  x: number; y: number; vx: number; vy: number; facing: number; grounded: number;
  hp: number; heat: number; st: number; move: number; stun: number; hitstop: number;
}
export interface MatchView {
  tick: number; phase: number; phaseT: number; timer: number; round: number;
  roundWinner: number; matchWinner: number; f: [FighterView, FighterView];
}
export type Buttons = { L: 1; R: 2; U: 4; D: 8; S: 16 };
/**
 * A fight script runs IN THE PAGE once per tick and returns both players'
 * masks. `t` counts from the first fighting tick (the countdown is skipped),
 * `s` is the live sim state. Keep it self-contained: it is stringified.
 */
export type FightScript = (t: number, s: MatchView, B: Buttons) => [number, number];

export interface CaptureOpts {
  outRoot: string;
  baseUrl: string;
  headless?: boolean;
  /** Step and log only, no screenshots: for tuning a script. */
  dry?: boolean;
}

export class Rig {
  private browser!: Browser;
  readonly opts: CaptureOpts;
  constructor(opts: CaptureOpts) {
    this.opts = opts;
  }

  async open(): Promise<void> {
    this.browser = await chromium.launch({
      headless: this.opts.headless ?? false,
      args: ["--enable-gpu-rasterization", "--ignore-gpu-blocklist", "--hide-scrollbars", "--autoplay-policy=no-user-gesture-required"],
    });
  }
  async close(): Promise<void> {
    await this.browser?.close();
  }

  async context(vp: Viewport): Promise<BrowserContext> {
    const ctx = await this.browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: vp.deviceScaleFactor ?? 1,
      isMobile: vp.mobile ?? false,
      hasTouch: vp.mobile ?? false,
      colorScheme: "dark",
      reducedMotion: "no-preference",
      userAgent: vp.mobile
        ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
        : undefined,
    });
    // A virtual clock for everything render-timed: performance.now and the
    // rAF timestamp advance exactly one tick per captured frame, so shake,
    // particles and mixers stay in step with the sim however long a
    // screenshot takes. Timers (setTimeout, fetch) are untouched.
    await ctx.addInitScript(() => {
      const w = window as unknown as { __vt: number; __vtOn: boolean };
      w.__vt = 0;
      w.__vtOn = false;
      const realNow = performance.now.bind(performance);
      const realRaf = window.requestAnimationFrame.bind(window);
      let base = 0;
      performance.now = () => (w.__vtOn ? w.__vt : realNow());
      window.requestAnimationFrame = (cb: FrameRequestCallback) =>
        realRaf((ts) => {
          if (!w.__vtOn) base = ts;
          cb(w.__vtOn ? w.__vt : ts);
        });
      void base;
    });
    return ctx;
  }

  /** Waits for a fight to be loaded and started. */
  async fightReady(page: Page): Promise<void> {
    await page.waitForFunction(() => {
      const cf = (window as unknown as { __cockfight?: { fight?: { ready(): boolean } } }).__cockfight;
      return !!cf?.fight?.ready();
    }, null, { timeout: 60_000 });
    // Let the model, arena and fonts settle a couple of real frames.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  }

  /**
   * Runs one scripted fight, one PNG per tick from `from` for `ticks` ticks.
   * Every tick's events are kept (frame index → events) so the edit can cut
   * on the impact frame and lay the game's sounds back in.
   */
  async fight(name: string, opts: { url: string; viewport?: Viewport; script: FightScript; ticks: number; skipCountdown?: boolean; from?: number; settleTicks?: number }): Promise<ShotResult> {
    const vp = opts.viewport ?? DESKTOP;
    const ctx = await this.context(vp);
    const page = await ctx.newPage();
    const dir = this.shotDir(name);
    const t0 = Date.now();
    try {
      await page.goto(this.opts.baseUrl + opts.url, { waitUntil: "networkidle" });
      await this.fightReady(page);
      await page.evaluate((src) => {
        const w = window as unknown as { __vtOn: boolean; __vt: number; __cfScript: unknown; __cfT: number };
        w.__vtOn = true;
        w.__vt = 0;
        w.__cfScript = new Function("return (" + src + ")")();
        w.__cfT = 0;
      }, opts.script.toString());
      // The countdown (180 ticks) is stepped without capture unless asked for.
      if (opts.skipCountdown !== false) {
        await page.evaluate(() => {
          const cf = (window as unknown as { __cockfight: { fight: { state(): MatchView; stepTicks(n: number): void } } }).__cockfight.fight;
          let guard = 0;
          while (cf.state().phase === 0 && guard++ < 400) cf.stepTicks(1);
        });
      }
      const from = opts.from ?? 0;
      const events: Record<number, unknown[]> = {};
      const sounds: Record<number, string[]> = {};
      const states: Record<number, MatchView> = {};
      let frame = 0;
      for (let t = 0; t < from + opts.ticks; t++) {
        const r = await page.evaluate((tickMs) => {
          const w = window as unknown as {
            __vt: number;
            __cfT: number;
            __cfScript: FightScript;
            __cockfight: { fight: { state(): MatchView; events(): unknown[]; sounds(): readonly string[]; setInput(p: 0 | 1, m: number): void; stepTicks(n: number): void; B: Buttons } };
          };
          const cf = w.__cockfight.fight;
          const [a, b] = w.__cfScript(w.__cfT, cf.state(), cf.B);
          cf.setInput(0, a);
          cf.setInput(1, b);
          // The director's recent-sounds list is a rolling window; emptied
          // before the step it holds exactly this tick's cues afterwards.
          const recent = cf.sounds() as unknown as string[];
          recent.length = 0;
          cf.stepTicks(1);
          w.__cfT++;
          w.__vt += tickMs;
          const s = cf.state();
          return { sounds: recent.slice(), events: JSON.parse(JSON.stringify(cf.events())), state: { tick: s.tick, phase: s.phase, phaseT: s.phaseT, timer: s.timer, round: s.round, roundWinner: s.roundWinner, matchWinner: s.matchWinner, f: s.f.map((f) => ({ x: f.x, y: f.y, vx: f.vx, vy: f.vy, facing: f.facing, grounded: f.grounded, hp: f.hp, heat: f.heat, st: f.st, move: f.move, stun: f.stun, hitstop: f.hitstop })) } as MatchView };
        }, TICK_MS);
        if (t >= from) {
          if (!this.opts.dry) {
            await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
            await page.screenshot({ path: join(dir, `f${String(frame).padStart(5, "0")}.png`), type: "png", animations: "allow", caret: "hide" });
          }
          if (r.events.length) events[frame] = r.events;
          if (r.sounds.length) sounds[frame] = r.sounds;
          states[frame] = r.state;
          frame++;
        }
      }
      writeFileSync(join(dir, this.opts.dry ? "events.dry.json" : "events.json"), JSON.stringify({ name, fps: 60, frames: frame, from, events, sounds, states }, null, 0));
      const out = this.opts.dry ? "" : this.encode(dir, name, 60);
      return { name, frames: frame, file: out, seconds: (Date.now() - t0) / 1000 };
    } finally {
      await ctx.close();
    }
  }

  /** A full-page still (the edit pans over it) or the viewport only. */
  async still(name: string, opts: { url: string; viewport?: Viewport; fullPage?: boolean; before?: (page: Page) => Promise<void>; settleMs?: number }): Promise<ShotResult> {
    const ctx = await this.context(opts.viewport ?? DESKTOP);
    const page = await ctx.newPage();
    const dir = this.shotDir(name);
    try {
      await page.goto(this.opts.baseUrl + opts.url, { waitUntil: "networkidle" });
      await page.waitForTimeout(opts.settleMs ?? 1500);
      if (opts.before) await opts.before(page);
      const file = join(dir, "still.png");
      await page.screenshot({ path: file, type: "png", fullPage: opts.fullPage ?? false });
      return { name, frames: 1, file, seconds: 0 };
    } finally {
      await ctx.close();
    }
  }

  /**
   * A live capture of a page for `seconds` at roughly `fps` (the pool
   * ticking, the leaderboard countdown, a hover). Real time, real
   * timestamps; encoded at the output frame rate with the frames held.
   */
  async live(name: string, opts: { url: string; viewport?: Viewport; seconds: number; fps?: number; before?: (page: Page) => Promise<void>; during?: (page: Page, t: number) => Promise<void> }): Promise<ShotResult> {
    const ctx = await this.context(opts.viewport ?? DESKTOP);
    const page = await ctx.newPage();
    const dir = this.shotDir(name);
    const fps = opts.fps ?? 15;
    try {
      await page.goto(this.opts.baseUrl + opts.url, { waitUntil: "networkidle" });
      await page.waitForTimeout(1200);
      if (opts.before) await opts.before(page);
      const start = Date.now();
      const stamps: number[] = [];
      let frame = 0;
      while (Date.now() - start < opts.seconds * 1000) {
        const t = (Date.now() - start) / 1000;
        if (opts.during) await opts.during(page, t);
        await page.screenshot({ path: join(dir, `f${String(frame).padStart(5, "0")}.png`), type: "png" });
        stamps.push(t);
        frame++;
        const next = start + (frame * 1000) / fps;
        const wait = next - Date.now();
        if (wait > 0) await page.waitForTimeout(wait);
      }
      // concat demuxer with real durations → constant 60 fps intermediate.
      const lines = stamps.map((s, i) => `file 'f${String(i).padStart(5, "0")}.png'\nduration ${((stamps[i + 1] ?? s + 1 / fps) - s).toFixed(4)}`);
      writeFileSync(join(dir, "frames.txt"), lines.join("\n") + "\n");
      const out = join(dir, "shot.mp4");
      run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", join(dir, "frames.txt"), "-vf", "fps=60,format=yuv420p", "-c:v", "libx264", "-preset", "slow", "-crf", "12", out]);
      writeFileSync(join(dir, "events.json"), JSON.stringify({ name, fps: 60, frames: frame, live: true, stamps }));
      return { name, frames: frame, file: out, seconds: opts.seconds };
    } finally {
      await ctx.close();
    }
  }

  /**
   * A title card: an HTML file whose CSS animations are stepped through the
   * Web Animations API one frame at a time, captured with alpha so the edit
   * can overlay it. `hold` extra frames are captured at the end state.
   */
  async card(name: string, opts: { file: string; frames: number; viewport?: Viewport; alpha?: boolean }): Promise<ShotResult> {
    const ctx = await this.context(opts.viewport ?? DESKTOP_1X);
    const page = await ctx.newPage();
    const dir = this.shotDir(name);
    const t0 = Date.now();
    try {
      await page.goto("file://" + resolve(opts.file), { waitUntil: "networkidle" });
      await page.evaluate(async () => {
        await document.fonts.ready;
        for (const a of document.getAnimations()) a.pause();
      });
      for (let f = 0; f < opts.frames; f++) {
        await page.evaluate((ms) => {
          for (const a of document.getAnimations()) a.currentTime = ms;
        }, f * TICK_MS);
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
        await page.screenshot({ path: join(dir, `f${String(f).padStart(5, "0")}.png`), type: "png", omitBackground: opts.alpha ?? true, animations: "allow" });
      }
      writeFileSync(join(dir, "events.json"), JSON.stringify({ name, fps: 60, frames: opts.frames, card: true, alpha: opts.alpha ?? true }));
      // Cards keep their PNGs (alpha); the edit reads the sequence directly.
      return { name, frames: opts.frames, file: join(dir, "f%05d.png"), seconds: (Date.now() - t0) / 1000 };
    } finally {
      await ctx.close();
    }
  }

  /** Two contexts, one local open-mode server: an online match for the queue and result screens. */
  async page(vp: Viewport): Promise<{ ctx: BrowserContext; page: Page }> {
    const ctx = await this.context(vp);
    return { ctx, page: await ctx.newPage() };
  }

  shotDir(name: string): string {
    const dir = join(this.opts.outRoot, "shots", name);
    if (!this.opts.dry) rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * Exports every procedural game sound as a 16-bit WAV (the engine renders
   * them once the fight page has user activation, which Playwright grants).
   */
  async sounds(outDir: string): Promise<string[]> {
    const ctx = await this.context(DESKTOP_1X);
    const page = await ctx.newPage();
    try {
      await page.goto(this.opts.baseUrl + "/play?mode=2p&debug=1&seed=sfx&arena=0&quality=low", { waitUntil: "networkidle" });
      await this.fightReady(page);
      await page.waitForFunction(() => {
        const a = (window as unknown as { __cockfight?: { audio?: { rendered(): number; total(): number } } }).__cockfight?.audio;
        return !!a && a.total() > 0 && a.rendered() === a.total();
      }, null, { timeout: 60_000 });
      const names: string[] = await page.evaluate(() => (window as unknown as { __cockfight: { audio: { total(): number } } }).__cockfight.audio.total() ? Array.from((window as unknown as { __cfNames?: string[] }).__cfNames ?? []) : []);
      void names;
      const all = await page.evaluate(() => {
        const a = (window as unknown as { __cockfight: { audio: { buffer(n: string): AudioBuffer | null } } }).__cockfight.audio;
        const NAMES = ["hit_light", "hit_heavy", "hit_slam", "hit_super", "block", "whiff_light", "whiff_heavy", "scream_light", "scream_medium", "scream_heavy", "scream_ko", "crowd_loop", "crowd_swell", "crowd_roar", "ko_horn", "round_bell", "countdown_tick", "fight", "ringout", "super_start", "heat_full", "dash", "jump", "land", "timeout", "win_jingle", "ui_move", "ui_select", "ui_back", "pause"];
        const out: Record<string, { rate: number; pcm: string }> = {};
        for (const n of NAMES) {
          const b = a.buffer(n);
          if (!b) continue;
          const d = b.getChannelData(0);
          const i16 = new Int16Array(d.length);
          for (let i = 0; i < d.length; i++) i16[i] = Math.max(-32768, Math.min(32767, Math.round((d[i] ?? 0) * 32767)));
          let bin = "";
          const u8 = new Uint8Array(i16.buffer);
          for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + 0x8000)));
          out[n] = { rate: b.sampleRate, pcm: btoa(bin) };
        }
        return out;
      });
      ensureDir(outDir);
      const written: string[] = [];
      for (const [n, { rate, pcm }] of Object.entries(all)) {
        const data = Buffer.from(pcm, "base64");
        const hdr = Buffer.alloc(44);
        hdr.write("RIFF", 0); hdr.writeUInt32LE(36 + data.length, 4); hdr.write("WAVE", 8); hdr.write("fmt ", 12);
        hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22); hdr.writeUInt32LE(rate, 24);
        hdr.writeUInt32LE(rate * 2, 28); hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34); hdr.write("data", 36); hdr.writeUInt32LE(data.length, 40);
        writeFileSync(join(outDir, n + ".wav"), Buffer.concat([hdr, data]));
        written.push(n);
      }
      return written;
    } finally {
      await ctx.close();
    }
  }

  /** PNG sequence → near-lossless H.264 intermediate at the tick rate; the PNGs are dropped. */
  encode(dir: string, name: string, fps: number): string {
    const out = join(dir, "shot.mp4");
    run("ffmpeg", ["-y", "-framerate", String(fps), "-i", join(dir, "f%05d.png"), "-c:v", "libx264", "-preset", "slow", "-crf", "10", "-pix_fmt", "yuv420p", out]);
    // Keep the first frame as a thumbnail; everything else is in the mp4.
    for (const f of readdirSync(dir)) if (/^f\d{5}\.png$/.test(f) && f !== "f00000.png") rmSync(join(dir, f));
    return out;
  }
}

export interface ShotResult {
  name: string;
  frames: number;
  file: string;
  seconds: number;
}

export function run(cmd: string, args: string[]): void {
  const r = spawnSync(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}\n${r.stderr}`);
}

export function ensureDir(p: string): string {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
  return p;
}
