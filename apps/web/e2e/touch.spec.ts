import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { B, Mv, St } from "../../../packages/sim/src/types";
import { HUD_BAND_PX, INSET_SHARE, hudBandPx } from "../src/game/view/camera/hudBand";
import { watchProblems } from "./support/console";
import { openFight, stepTicks } from "./support/fight";
import { Fingers, centre, onPad } from "./support/touch";

/**
 * The on-screen buttons, driven by real touches on a phone-sized, touch-
 * enabled Chromium (the chromium-touch project: a Pixel 7). The sim is
 * stepped by hand (?manual=1), so each touch lands on a known tick. What the
 * masks do in the sim (dash, slam, dive, super...) is unit-tested in
 * src/game/match/input/touch.test.ts; this checks that fingers on the glass
 * make those masks, and that the layout holds in both orientations.
 *
 * No arena and the low tier: CI renders in software, about a frame a second.
 */
const CAP = (name: string) => fileURLToPath(new URL(`../../../docs/captures/phase-1/${name}`, import.meta.url));
/** The CPU stands still (?cpu=idle, debug only), so nothing but the touches moves P1. */
const FIGHT = "mode=cpu&manual=1&debug=1&cpu=idle&arena=0&quality=low";

interface Tick {
  mask: number;
  st: number;
  move: number;
  x: number;
  y: number;
  /** P2: how the last contact landed (1 hit, 2 blocked) and the gap between the two. */
  hit2: number;
  gap: number;
}
interface DebugFight {
  state(): { tick: number; matchWinner: number; f: { x: number; y: number; st: number; move: number; hitKind: number }[] };
  stepTicks(n: number): void;
  touchMask(): number;
  insets(): { bottomPx: number; bottomFrac: number };
  paused(): boolean;
  ready(): boolean;
  matchId(): string;
}

/** Steps n ticks one at a time and records P1 and the touch mask on each, then renders a frame. */
async function run(page: Page, n: number): Promise<Tick[]> {
  const out = await page.evaluate((k) => {
    const f = (window as unknown as { __cockfight: { fight: DebugFight } }).__cockfight.fight;
    const ticks: Tick[] = [];
    for (let i = 0; i < k; i++) {
      f.stepTicks(1);
      const [p, q] = f.state().f;
      ticks.push({ mask: f.touchMask(), st: p!.st, move: p!.move, x: p!.x, y: p!.y, hit2: q!.hitKind, gap: q!.x - p!.x });
    }
    return ticks;
  }, n);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
  return out;
}

const insets = (page: Page) => page.evaluate(() => (window as unknown as { __cockfight: { fight: DebugFight } }).__cockfight.fight.insets());

async function box(l: Locator) {
  const b = await l.boundingBox();
  if (!b) throw new Error("no box");
  return b;
}

/** Bottom (CSS px, from the top of the fight area) of the HUD's top band. */
const hudBand = (page: Page) =>
  page.evaluate(() => {
    const band = document.querySelector("[data-testid=fight-hud] > div")!.getBoundingClientRect();
    const area = document.querySelector("[data-testid=fight-area]")!.getBoundingClientRect();
    return band.bottom - area.top;
  });

/** No page scroll, no pinch or double-tap zoom: the gestures all went to the game. */
const still = (page: Page) => page.evaluate(() => [window.scrollX, window.scrollY, window.visualViewport?.scale ?? 1]);

function controls(page: Page) {
  return {
    root: page.getByTestId("touch-controls"),
    pad: page.getByTestId("touch-dpad"),
    peck: page.getByTestId("touch-peck"),
    ctx: page.getByTestId("touch-ctx"),
  };
}

test.describe("touch controls", () => {
  test.setTimeout(240_000);

  test("upright: a controller panel under the fight, and every button plays", async ({ page }) => {
    const problems = await watchProblems(page);
    await openFight(page, `${FIGHT}&seed=e2e-touch-up`);
    const { root, pad, peck, ctx } = controls(page);
    // A phone: the buttons show up without ?touch=1.
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    await expect(root).toBeVisible();

    // The fight on top (about square), the panel under it, nothing overlapping.
    const vp = page.viewportSize()!;
    const area = await box(page.getByTestId("fight-area"));
    expect(area.y).toBe(0);
    expect(area.height).toBeGreaterThanOrEqual(area.width * 0.95 - 1);
    for (const b of [pad, peck, ctx]) {
      const bb = await box(b);
      expect(bb.y).toBeGreaterThanOrEqual(area.y + area.height);
      expect(bb.y + bb.height).toBeLessThanOrEqual(vp.height);
      expect(bb.x).toBeGreaterThanOrEqual(0);
      expect(bb.x + bb.width).toBeLessThanOrEqual(vp.width);
    }
    expect(await hudBand(page)).toBeLessThanOrEqual(hudBandPx(area.width, area.height) - 14);
    expect((await insets(page)).bottomPx).toBe(0); // the camera needs no room: the buttons aren't over the fight
    await expect(ctx).toHaveAttribute("data-label", "JUMP");
    await expect(peck).toHaveAttribute("data-label", "PECK");

    await stepTicks(page, 181); // countdown
    const f = await Fingers.on(page);
    const right = await onPad(pad, 0.8, 0);
    const down = await onPad(pad, 0, 0.8);

    // Hold ▶: P1 walks right; let go and it stops.
    await f.press(1, right);
    let t = await run(page, 20);
    expect(t.every((r) => r.mask === B.R)).toBe(true);
    expect(t.at(-1)!.x).toBeGreaterThan(t[0]!.x);
    await f.lift(1);
    t = await run(page, 2);
    expect(t[0]!.mask).toBe(0);

    // A second thumb on the pad takes it; when it lifts, the first thumb (still down) has it back.
    await f.press(1, right);
    await f.press(2, await onPad(pad, -0.8, 0));
    t = await run(page, 2);
    expect(t.at(-1)!.mask).toBe(B.L);
    await f.lift(2);
    t = await run(page, 2);
    expect(t.at(-1)!.mask).toBe(B.R);
    await f.lift(1);
    t = await run(page, 2);
    expect(t.at(-1)!.mask).toBe(0);
    await run(page, 20);

    // Two quick taps on ▶, both before the next tick: still two presses, so a dash.
    await f.tap(1, right);
    await f.tap(1, right);
    t = await run(page, 4);
    expect(t.map((r) => r.mask)).toEqual([B.R, 0, B.R, 0]);
    expect(t.some((r) => r.st === St.dashF)).toBe(true);
    await run(page, 30);

    // Hold ▼: block, and the context button offers SLAM; a second thumb slams.
    await f.press(1, down);
    t = await run(page, 3);
    expect(t.at(-1)!.mask).toBe(B.D);
    expect(t.at(-1)!.st).toBe(St.block);
    await expect(ctx).toHaveAttribute("data-label", "SLAM");
    await f.press(2, ctx);
    t = await run(page, 3);
    expect(t[0]!.mask).toBe(B.D | B.S);
    expect(t.some((r) => r.move === Mv.slam)).toBe(true);
    await f.liftAll();
    await run(page, 80);

    // The context button jumps; in the air it reads DIVE and dives.
    await expect(ctx).toHaveAttribute("data-label", "JUMP");
    await f.tap(2, ctx);
    t = await run(page, 3);
    expect(t[0]!.mask).toBe(B.U);
    expect(t.some((r) => r.st === St.jump)).toBe(true);
    await expect(ctx).toHaveAttribute("data-label", "DIVE");
    await f.tap(2, ctx);
    t = await run(page, 30);
    expect(t.some((r) => r.move === Mv.dive_kick)).toBe(true);
    await run(page, 60);
    await expect(ctx).toHaveAttribute("data-label", "JUMP");

    // PECK: one Space press, and P1 pecks.
    await f.tap(3, peck);
    t = await run(page, 3);
    expect(t[0]!.mask).toBe(B.S);
    expect(t.some((r) => r.st === St.attack && r.move === Mv.peck)).toBe(true);
    await run(page, 20);

    // Walk in on ▶ (the thumb stays down while the sim steps) and land a peck.
    await f.press(1, right);
    await page.evaluate(() => {
      const fight = (window as unknown as { __cockfight: { fight: DebugFight } }).__cockfight.fight;
      for (let i = 0; i < 400 && fight.state().f[1]!.x - fight.state().f[0]!.x > 1200; i++) fight.stepTicks(1);
    });
    await f.lift(1);
    await run(page, 2);
    await f.tap(3, peck);
    t = await run(page, 12);
    expect(t.some((r) => r.hit2 === 1)).toBe(true);

    expect(await still(page)).toEqual([0, 0, 1]);
    await run(page, 8);
    await page.screenshot({ path: CAP("touch-portrait.png") });
    expect(problems.errors).toEqual([]);
  });

  test("sideways: see-through buttons in the corners clear of the fight, and turning the phone keeps the fight going", async ({ page }) => {
    const problems = await watchProblems(page);
    await page.setViewportSize({ width: 915, height: 412 });
    await openFight(page, `${FIGHT}&seed=e2e-touch-side`);
    const { root, pad, peck, ctx } = controls(page);
    await expect(root).toBeVisible();

    const checkSideways = async (w: number, h: number) => {
      const area = await box(page.getByTestId("fight-area"));
      expect(area.width).toBe(w);
      expect(area.height).toBe(h);
      // The compact HUD band (a phone held sideways is short).
      expect(hudBandPx(w, h)).toBe(HUD_BAND_PX.short);
      expect(await hudBand(page)).toBeLessThanOrEqual(HUD_BAND_PX.short - 14);
      // Bottom corners, clear of the screen edges (the system's back swipe).
      const p = await box(pad);
      const a = await box(peck);
      const c = await box(ctx);
      expect(p.x).toBeGreaterThanOrEqual(20);
      expect(p.x + p.width).toBeLessThan(w / 2);
      for (const b of [a, c]) {
        expect(b.x).toBeGreaterThan(w / 2);
        expect(b.x + b.width).toBeLessThanOrEqual(w - 20);
      }
      for (const b of [p, a, c]) expect(b.y + b.height).toBeLessThanOrEqual(h - 14);
      // The camera keeps a share of the buttons' reach clear of the feet.
      const reach = h - Math.min(p.y, a.y, c.y);
      // Polled: after a resize the observers report a frame later (and the reach may not change at all).
      await expect.poll(async () => (await insets(page)).bottomPx).toBeCloseTo(reach, 0);
      await expect.poll(async () => (await insets(page)).bottomFrac).toBeCloseTo(Math.min(0.3, (INSET_SHARE * reach) / h), 3);
    };
    await checkSideways(915, 412);

    await stepTicks(page, 181);
    const f = await Fingers.on(page);
    await f.press(1, await onPad(pad, 0.8, 0));
    let t = await run(page, 10);
    expect(t.every((r) => r.mask === B.R)).toBe(true);
    await f.lift(1);
    await f.tap(2, peck);
    t = await run(page, 3);
    expect(t[0]!.mask).toBe(B.S);
    expect(t.some((r) => r.move === Mv.peck)).toBe(true);
    await run(page, 20);
    await page.screenshot({ path: CAP("touch-landscape.png") });

    // A smaller phone sideways (iPhone-sized, browser bars showing).
    await page.setViewportSize({ width: 734, height: 343 });
    await expect.poll(async () => (await box(page.getByTestId("fight-area"))).height).toBe(343);
    await checkSideways(734, 343);

    // Turn the phone upright mid-fight: same fight, same engine, panel underneath, no inset.
    const before = await page.evaluate(() => {
      const fight = (window as unknown as { __cockfight: { fight: DebugFight & { __mark?: number } } }).__cockfight.fight;
      fight.__mark = 7;
      return { id: fight.matchId(), tick: fight.state().tick };
    });
    await page.setViewportSize({ width: 412, height: 839 });
    await expect.poll(async () => (await insets(page)).bottomPx).toBe(0);
    const after = await page.evaluate(() => {
      const fight = (window as unknown as { __cockfight: { fight: DebugFight & { __mark?: number } } }).__cockfight.fight;
      return { id: fight.matchId(), tick: fight.state().tick, mark: fight.__mark, ready: fight.ready() };
    });
    expect(after).toEqual({ ...before, mark: 7, ready: true });
    const area = await box(page.getByTestId("fight-area"));
    expect((await box(pad)).y).toBeGreaterThanOrEqual(area.y + area.height);
    await f.press(1, await onPad(pad, -0.8, 0));
    t = await run(page, 3);
    expect(t.every((r) => r.mask === B.L)).toBe(true);
    await f.lift(1);

    expect(await still(page)).toEqual([0, 0, 1]);
    expect(problems.errors).toEqual([]);
  });

  test("on-screen pause: the timer and the PAUSE pill open the menu, touches do nothing meanwhile, and play resumes", async ({ page }) => {
    const problems = await watchProblems(page);
    await openFight(page, `${FIGHT}&seed=e2e-touch-pause`);
    const { root, pad } = controls(page);
    await stepTicks(page, 181);
    const f = await Fingers.on(page);
    const right = await onPad(pad, 0.8, 0);
    const paused = () => page.evaluate(() => (window as unknown as { __cockfight: { fight: DebugFight } }).__cockfight.fight.paused());

    for (const opener of [page.getByTestId("hud-pause"), page.getByTestId("touch-pause")]) {
      await f.tap(1, opener);
      await expect(page.getByRole("dialog", { name: "Paused" })).toBeVisible();
      expect(await paused()).toBe(true);
      await expect(root).toHaveAttribute("data-active", "0");
      // A thumb on the d-pad while the menu is open reaches nothing.
      await f.press(2, right);
      const t = await run(page, 4);
      expect(t.every((r) => r.mask === 0)).toBe(true);
      await f.lift(2);

      await f.tap(1, page.getByRole("button", { name: "RESUME" }));
      await expect(page.getByRole("dialog", { name: "Paused" })).toBeHidden();
      expect(await paused()).toBe(false);
      await expect(root).toHaveAttribute("data-active", "1");
      await f.press(2, right);
      expect((await run(page, 2)).every((r) => r.mask === B.R)).toBe(true);
      await f.lift(2);
    }

    // The menu can't zoom iOS (its fields are 16 px or more) or pull-to-refresh the page.
    await f.tap(1, page.getByTestId("hud-pause"));
    const sizes = await page.getByRole("dialog", { name: "Paused" }).locator("select").evaluateAll((els) => els.map((e) => parseFloat(getComputedStyle(e).fontSize)));
    expect(sizes.length).toBe(2);
    for (const px of sizes) expect(px).toBeGreaterThanOrEqual(16);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).overscrollBehaviorY)).toBe("none");
    await f.tap(1, page.getByRole("button", { name: "RESUME" }));

    // The system back gesture (an edge swipe) pauses the fight instead of leaving it.
    const where = page.url();
    const id = await page.evaluate(() => (window as unknown as { __cockfight: { fight: DebugFight } }).__cockfight.fight.matchId());
    await page.evaluate(() => history.back());
    await expect(page.getByRole("dialog", { name: "Paused" })).toBeVisible();
    expect(page.url()).toBe(where);
    expect(await page.evaluate(() => (window as unknown as { __cockfight: { fight: DebugFight } }).__cockfight.fight.matchId())).toBe(id);
    // Resuming arms it again.
    await f.tap(1, page.getByRole("button", { name: "RESUME" }));
    await expect(page.getByRole("dialog", { name: "Paused" })).toBeHidden();
    await page.evaluate(() => history.back());
    await expect(page.getByRole("dialog", { name: "Paused" })).toBeVisible();
    expect(await paused()).toBe(true);
    await f.tap(1, page.getByRole("button", { name: "RESUME" }));

    // The SOUND pill mutes (and unmutes).
    const mute = page.getByTestId("touch-mute");
    await expect(mute).toHaveAttribute("aria-label", "Sound off");
    await f.tap(1, mute);
    await expect(mute).toHaveAttribute("aria-label", "Sound on");
    await f.tap(1, mute);
    await expect(mute).toHaveAttribute("aria-label", "Sound off");

    expect(await still(page)).toEqual([0, 0, 1]);
    expect(problems.errors).toEqual([]);
  });

  test("match over: the controls step aside and the buttons fit a small phone", async ({ page }) => {
    const problems = await watchProblems(page);
    await page.setViewportSize({ width: 390, height: 664 });
    await openFight(page, "mode=cpu&difficulty=hard&manual=1&debug=1&arena=0&quality=low&seed=e2e-touch-end");

    // Small phones (iPhone 14, then an iPhone SE, with Safari's bars): the pills never sit on the pad or the buttons.
    const overlap = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
      !(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
    for (const [w, h] of [[390, 664], [375, 548]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))));
      const pills = await Promise.all([page.getByTestId("touch-mute"), page.getByTestId("touch-pause")].map(box));
      const pads = await Promise.all([page.getByTestId("touch-dpad"), page.getByTestId("touch-peck"), page.getByTestId("touch-ctx")].map(box));
      const area = await box(page.getByTestId("fight-area"));
      for (const p of pads) {
        for (const q of pills) expect(overlap(p, q), `${w}x${h}: a pill overlaps a control`).toBe(false);
        expect(p.y, `${w}x${h}`).toBeGreaterThanOrEqual(area.y + area.height);
        expect(p.y + p.height, `${w}x${h}`).toBeLessThanOrEqual(h);
      }
    }
    await page.setViewportSize({ width: 390, height: 664 });
    // Nobody touches P1: the CPU wins.
    await page.evaluate(() => {
      const f = (window as unknown as { __cockfight: { fight: DebugFight } }).__cockfight.fight;
      for (let i = 0; i < 40 && f.state().matchWinner < 0; i++) f.stepTicks(600);
    });
    await stepTicks(page, 1);
    const end = page.getByTestId("match-end");
    await expect(end).toBeVisible();
    await expect(page.getByTestId("touch-controls")).toHaveAttribute("data-active", "0");
    await expect(end.getByRole("button", { name: "REMATCH" })).toBeVisible();

    const area = await box(page.getByTestId("fight-area"));
    const buttons = await end.locator("button, a").all();
    expect(buttons.length).toBe(3);
    const boxes = await Promise.all(buttons.map(box));
    for (const b of boxes) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width).toBeLessThanOrEqual(390);
      expect(b.y).toBeGreaterThanOrEqual(area.y + area.height); // on the panel, not over the fight
      expect(b.y + b.height).toBeLessThanOrEqual(664);
    }
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        const apart = a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
        expect(apart, `buttons ${i} and ${j} overlap`).toBe(true);
      }

    // REMATCH by touch starts the next fight.
    const f = await Fingers.on(page);
    await f.tap(1, await centre(end.getByRole("button", { name: "REMATCH" })));
    await expect(end).toBeHidden();
    await expect(page.getByTestId("touch-controls")).toHaveAttribute("data-active", "1", { timeout: 60_000 });
    expect(problems.errors).toEqual([]);
  });

  // Local only (pnpm exec playwright test --project=webkit-touch): an iPhone
  // in WebKit, with Playwright's own touchscreen (no CDP there).
  test("@webkit an iPhone: tapping PECK pecks, and taps on the fight never zoom the page", async ({ page }) => {
    // WebKit notes on the console that a report-only policy without report-to has no effect (it is report-only on purpose).
    const problems = await watchProblems(page, { ignore: (m) => /delivered in report-only mode/.test(m.text()) });
    await openFight(page, `${FIGHT}&seed=e2e-touch-ios`);
    const { root, peck } = controls(page);
    await expect(root).toBeVisible();
    await stepTicks(page, 181);
    const at = await centre(peck);
    await page.touchscreen.tap(at.x, at.y);
    const t = await run(page, 3);
    expect(t[0]!.mask).toBe(B.S);
    expect(t.some((r) => r.move === Mv.peck)).toBe(true);
    // A double tap on the fight and on the pad: no double-tap zoom.
    const area = await centre(page.getByTestId("fight-area"));
    for (const p of [area, at]) {
      await page.touchscreen.tap(p.x, p.y);
      await page.touchscreen.tap(p.x, p.y);
    }
    await page.waitForTimeout(400);
    expect(await still(page)).toEqual([0, 0, 1]);
    expect(problems.errors).toEqual([]);
  });
});
