import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import type { PerfSnapshot } from "../src/game/engine/perf";

/**
 * Local-only performance check (`pnpm test:perf`): a real-time CPU-vs-CPU match
 * on the production build, measured after FIGHT. Two configurations:
 *  - desktop (ANGLE over Metal on an Apple Silicon Mac), quality high;
 *  - "3-year-old Android" proxy: Pixel 7 emulation with 4x CPU throttling,
 *    quality medium. It proxies CPU cost only, not a phone GPU: the real check
 *    is /play?bench=1 on a phone (numbers pasted into the PR).
 * Hard budgets: draw calls, triangles, and no shader compiles after FIGHT.
 */
const OUT = fileURLToPath(new URL("../../../docs/captures/phase-1/perf.json", import.meta.url));
const results: Record<string, unknown> = {};

async function measure(page: Page, query: string, seconds: number) {
  await page.goto(`/play?${query}`);
  await page.waitForFunction(() => (window as unknown as { __cockfight?: { fight?: { ready(): boolean } } }).__cockfight?.fight?.ready() === true, null, {
    timeout: 90_000,
  });
  const fight = () => page.evaluate(() => (window as unknown as { __cockfight: { fight: { state(): { phase: number }; perf(): PerfSnapshot } } }).__cockfight.fight.perf());
  // Wait for FIGHT (the meter resets itself there), then measure.
  await page.waitForFunction(() => (window as unknown as { __cockfight: { fight: { state(): { phase: number } } } }).__cockfight.fight.state().phase === 1, null, { timeout: 30_000 });
  const programsAtFight = (await fight()).programs;
  await page.waitForTimeout(seconds * 1000);
  const p = await fight();
  return { ...p, programsAtFight };
}

test.describe("perf", () => {
  test.afterAll(() => {
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2) + "\n");
  });

  test("desktop, quality high", async ({ page }) => {
    const r = await measure(page, "mode=demo&difficulty=hard&seed=perf&quality=high", 20);
    results.desktop = r;
    console.log("desktop", JSON.stringify(r));
    expect(r.drawCalls).toBeLessThanOrEqual(40);
    expect(r.triangles).toBeLessThanOrEqual(150_000);
    expect(r.programs, "no shader compiles after FIGHT").toBe(r.programsAtFight);
    expect(r.p95).toBeLessThanOrEqual(1000 / 60 + 4);
  });

  test("mobile proxy: Pixel 7 emulation, 4x CPU throttle, quality medium", async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 915, height: 412 },
      deviceScaleFactor: 2.625,
      isMobile: true,
      hasTouch: true,
      userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36",
    });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    const r = await measure(page, "mode=demo&difficulty=hard&seed=perf&quality=medium", 20);
    results.mobileProxy = r;
    console.log("mobile proxy", JSON.stringify(r));
    expect(r.drawCalls).toBeLessThanOrEqual(40);
    expect(r.programs).toBe(r.programsAtFight);
    await context.close();
  });
});
