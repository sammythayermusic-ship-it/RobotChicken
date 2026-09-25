import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { hudBandPx } from "../src/game/view/camera/hudBand";
import { watchProblems } from "./support/console";
import { openFight, snap, stepTicks } from "./support/fight";

const CAP = (name: string) => fileURLToPath(new URL(`../../../docs/captures/phase-1/${name}`, import.meta.url));

interface Perf {
  drawCalls: number;
  triangles: number;
  programs: number;
}

interface DebugFight {
  perf(): Perf;
  setInput(player: 0 | 1, mask: number): void;
  stepTicks(n: number): void;
  state(): { f: { x: number; y: number; st: number }[]; phase: number };
  B: { L: number; R: number; U: number; D: number; S: number };
}

const perf = (page: Page) => page.evaluate(() => (window as unknown as { __cockfight: { fight: DebugFight } }).__cockfight.fight.perf());

/** Arena captures show the set, not the HUD (fight.spec.ts covers the HUD). */
const hideHud = (page: Page) => page.addStyleTag({ content: "[data-testid=fight-hud]{display:none !important}" });

/** Let the fires, crowd and beams run a few real frames (they animate on wall-clock fx time). */
const settle = (page: Page, ms = 400) => page.waitForTimeout(ms);

/** P2 walks to the right-hand wall, P1 follows until they are close. Returns once P1 is in range. */
async function cornerP2(page: Page): Promise<void> {
  await page.evaluate(() => {
    const f = (window as unknown as { __cockfight: { fight: DebugFight } }).__cockfight.fight;
    f.setInput(1, f.B.R);
    f.stepTicks(200);
    f.setInput(1, 0);
    f.setInput(0, f.B.R);
    for (let i = 0; i < 400; i++) {
      const s = f.state();
      if ((s.f[1]?.x ?? 0) - (s.f[0]?.x ?? 0) < 1300) break;
      f.stepTicks(1);
    }
    f.setInput(0, 0);
    f.stepTicks(20);
  });
}

/** Both fighters back off to the walk limits (9.5 u). */
async function toTheWalls(page: Page): Promise<void> {
  await page.evaluate(() => {
    const f = (window as unknown as { __cockfight: { fight: DebugFight } }).__cockfight.fight;
    f.setInput(0, f.B.L);
    f.setInput(1, f.B.R);
    f.stepTicks(160);
    f.setInput(0, 0);
    f.setInput(1, 0);
    f.stepTicks(60); // the camera settles
  });
}

/** The fighters walk in until they are 1.3 u apart, then P1 jumps straight up; returns at the apex (y in mu). */
async function jumpUpClose(page: Page): Promise<number> {
  return page.evaluate(() => {
    const f = (window as unknown as { __cockfight: { fight: DebugFight } }).__cockfight.fight;
    f.setInput(0, f.B.R);
    f.setInput(1, f.B.L);
    for (let i = 0; i < 400; i++) {
      const s = f.state();
      if ((s.f[1]?.x ?? 0) - (s.f[0]?.x ?? 0) < 1300) break;
      f.stepTicks(1);
    }
    f.setInput(0, 0);
    f.setInput(1, 0);
    f.stepTicks(60);
    f.setInput(0, f.B.U);
    f.stepTicks(2);
    f.setInput(0, 0);
    let top = 0;
    for (let i = 0; i < 60; i++) {
      f.stepTicks(1);
      const y = f.state().f[0]?.y ?? 0;
      if (y < top) break;
      top = y;
    }
    return top;
  });
}

/** Bottom (CSS px) of the HUD's top band: names, bars, timer. */
const hudBandBottom = (page: Page) =>
  page.evaluate(() => {
    const band = document.querySelector("[data-testid=fight-hud] > div");
    return band ? band.getBoundingClientRect().bottom : 0;
  });

/**
 * Framing across aspects: the camera must keep both fighters (at the walls)
 * inside the frame and a full jump below the HUD band, landscape and portrait.
 * The math is unit-tested (FightCamera.test.ts, through the real three
 * camera); these shots are for the eye. The HUD stays on: it is part of the
 * contract.
 */
const VIEWS = [
  { name: "16x9", width: 1280, height: 720, wide: null, jump: "arena-jump.png" },
  { name: "phone", width: 915, height: 412, wide: "arena-phone-wide.png", jump: "arena-phone-jump.png" },
  { name: "portrait", width: 412, height: 915, wide: "arena-portrait.png", jump: null },
] as const;

test.describe("junkyard arena", () => {
  for (const v of VIEWS) {
    test(`frames both fighters and a full jump clear of the HUD: ${v.name} ${v.width}x${v.height}`, async ({ page }, info) => {
      const problems = await watchProblems(page);
      await page.setViewportSize({ width: v.width, height: v.height });
      await openFight(page, `mode=2p&manual=1&debug=1&seed=e2e-frame-${v.name}`);
      await stepTicks(page, 200);
      // The camera keeps fighters below this many px; the real HUD must not reach past it.
      const band = await hudBandBottom(page);
      console.log(`[arena] ${v.name}: HUD band ends at ${band.toFixed(1)} px (camera assumes ${hudBandPx(v.width, v.height)})`);
      expect(band).toBeLessThanOrEqual(hudBandPx(v.width, v.height) - 14); // - room for "SUPER READY"
      // The bars stay (they are what the jump must clear); the FIGHT! banner would only cover the fighters.
      await page.addStyleTag({ content: "[data-testid=hud-banner]{display:none !important}" });

      await toTheWalls(page);
      await settle(page);
      const s = await snap(page);
      expect(s.f[0]!.x).toBe(-9500);
      expect(s.f[1]!.x).toBe(9500);
      await page.screenshot({ path: v.wide ? CAP(v.wide) : info.outputPath("wide.png") });

      const apex = await jumpUpClose(page);
      expect(apex).toBeGreaterThan(2400);
      await settle(page, 150);
      await page.screenshot({ path: v.jump ? CAP(v.jump) : info.outputPath("jump.png") });
      expect(problems.errors).toEqual([]);
    });
  }

  test("quality 'low' cuts the arena's own draws and triangles", async ({ page }) => {
    test.setTimeout(240_000); // six page loads, each a slow first frame under CI's software GL
    const problems = await watchProblems(page);
    const cost: Record<string, { drawCalls: number; triangles: number }> = {};
    for (const tier of ["high", "medium", "low"] as const) {
      const measure = async (arena: boolean) => {
        await openFight(page, `mode=2p&manual=1&debug=1&seed=e2e-quality&quality=${tier}${arena ? "" : "&arena=0"}`);
        await stepTicks(page, 200);
        await settle(page, 200);
        return perf(page);
      };
      const bare = await measure(false);
      const full = await measure(true);
      cost[tier] = { drawCalls: full.drawCalls - bare.drawCalls, triangles: full.triangles - bare.triangles };
      console.log(`[arena] quality ${tier}: whole frame ${full.drawCalls} draws / ${full.triangles} tris; arena +${cost[tier].drawCalls} draws / +${cost[tier].triangles} tris`);
    }
    expect(cost.high).toEqual(cost.medium); // the arena itself only has a 'low' variant
    expect(cost.low!.drawCalls).toBe(cost.medium!.drawCalls - 1); // the crowd's flash pass
    expect(cost.low!.triangles).toBeLessThan(cost.medium!.triangles - 500); // + smoke, embers, haze
    expect(problems.errors).toEqual([]);
  });

  test("renders the pit with both fighters inside the frame budget", async ({ page }) => {
    const problems = await watchProblems(page);
    await openFight(page, "mode=2p&manual=1&debug=1&seed=e2e-arena");
    await stepTicks(page, 200);
    await settle(page);
    const p = await perf(page);
    console.log(`[arena] fight frame: ${p.drawCalls} draw calls, ${p.triangles} triangles, ${p.programs} programs`);
    expect(p.drawCalls).toBeLessThanOrEqual(40);
    expect(p.triangles).toBeLessThanOrEqual(150_000);
    await hideHud(page);
    await page.screenshot({ path: CAP("arena.png") });

    // Wide: both fighters back off to the walk limits, the camera pulls out to the full pit.
    await page.evaluate(() => {
      const f = (window as unknown as { __cockfight: { fight: DebugFight } }).__cockfight.fight;
      f.setInput(0, f.B.L);
      f.setInput(1, f.B.R);
      f.stepTicks(160);
      f.setInput(0, 0);
      f.setInput(1, 0);
    });
    await stepTicks(page, 30);
    await settle(page);
    const wide = await perf(page);
    expect(wide.drawCalls).toBeLessThanOrEqual(40);
    expect(wide.triangles).toBeLessThanOrEqual(150_000);
    await page.screenshot({ path: CAP("arena-wide.png") });

    expect(problems.errors).toEqual([]);
    expect(await problems.cspViolations()).toEqual([]);
  });

  test("a ring-out drops the loser off the lip and the crowd erupts", async ({ page }) => {
    const problems = await watchProblems(page);
    await openFight(page, "mode=2p&manual=1&debug=1&seed=e2e-arena-ro");
    await stepTicks(page, 200);
    await cornerP2(page);
    await hideHud(page);
    await settle(page, 250);
    await page.screenshot({ path: CAP("arena-edge.png") });

    // P1 shoves (Space while holding toward): shove carries past the ring edge.
    const fell = await page.evaluate(() => {
      const f = (window as unknown as { __cockfight: { fight: DebugFight } }).__cockfight.fight;
      f.setInput(0, f.B.R | f.B.S);
      f.stepTicks(2);
      f.setInput(0, 0);
      for (let i = 0; i < 120; i++) {
        const s = f.state();
        if ((s.f[1]?.y ?? 0) < -600) return true;
        f.stepTicks(1);
      }
      return false;
    });
    expect(fell).toBe(true);
    const s = await snap(page);
    expect(Math.abs(s.f[1]!.x)).toBeGreaterThan(10_000);
    await page.screenshot({ path: CAP("arena-ringout.png") });

    // A second later (real time: the KO pulse fades) the crowd is on its feet, wings up, flashes going.
    await stepTicks(page, 20);
    await settle(page, 1200);
    await page.screenshot({ path: CAP("arena-hype.png") });

    expect(problems.errors).toEqual([]);
    expect(await problems.cspViolations()).toEqual([]);
  });

  test("/play?arena=0 still fights on the placeholder floor, and the arena costs a handful of draws", async ({ page }) => {
    const problems = await watchProblems(page);
    await openFight(page, "mode=2p&manual=1&debug=1&seed=e2e-noarena&arena=0");
    await stepTicks(page, 200);
    await settle(page, 200);
    const bare = await perf(page);
    expect((await snap(page)).phase).toBe(1);

    await openFight(page, "mode=2p&manual=1&debug=1&seed=e2e-noarena");
    await stepTicks(page, 200);
    await settle(page, 200);
    const full = await perf(page);
    const draws = full.drawCalls - bare.drawCalls;
    const tris = full.triangles - bare.triangles;
    console.log(`[arena] arena cost: +${draws} draw calls, +${tris} triangles`);
    // Arena: 7 draws (sky, floor, props, crowd, crowd flashes, fire, beams) minus the placeholder floor.
    expect(draws).toBeGreaterThan(0);
    expect(draws).toBeLessThanOrEqual(12);
    expect(tris).toBeLessThanOrEqual(60_000);

    // RESTART remounts the engine: the old arena is disposed with its context, a new one is built.
    type W = { __cockfight?: { fight?: { ready(): boolean } }; __oldFight?: unknown };
    await page.evaluate(() => {
      const w = window as unknown as W;
      w.__oldFight = w.__cockfight?.fight;
    });
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "RESTART" }).click();
    await page.waitForFunction(() => {
      const w = window as unknown as W;
      const f = w.__cockfight?.fight;
      return !!f && f !== w.__oldFight && f.ready();
    });
    await stepTicks(page, 200);
    expect((await perf(page)).drawCalls).toBe(full.drawCalls);
    expect(problems.errors).toEqual([]);
  });
});
