import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { watchProblems } from "./support/console";
import { fightCall, openFight, snap, stepTicks } from "./support/fight";

const CAP = (name: string) => fileURLToPath(new URL(`../../../docs/captures/phase-1/${name}`, import.meta.url));

test.describe("local fight", () => {
  test("two players on one keyboard: real key presses walk and peck", async ({ page }) => {
    const problems = await watchProblems(page);
    await openFight(page, "mode=2p&manual=1&debug=1&seed=e2e-2p");
    await stepTicks(page, 181); // countdown
    let s = await snap(page);
    expect(s.phase).toBe(1);
    const gap0 = s.f[1]!.x - s.f[0]!.x;

    // P1 holds D (walk right) while ticks advance inside the page.
    await page.keyboard.down("KeyD");
    for (let i = 0; i < 120 && (await snap(page)).f[1]!.x - (await snap(page)).f[0]!.x > 1100; i++) await stepTicks(page, 1);
    await page.keyboard.up("KeyD");
    s = await snap(page);
    expect(s.f[1]!.x - s.f[0]!.x).toBeLessThan(gap0);

    // P1 pecks: Space (a tap shorter than a tick still registers).
    await page.keyboard.press("Space");
    for (let i = 0; i < 12 && (await snap(page)).f[1]!.hitKind === 0; i++) await stepTicks(page, 1);
    s = await snap(page);
    expect(s.f[1]!.hitKind).toBe(1);
    expect(s.f[1]!.hp).toBe(10000 - 600);
    await page.screenshot({ path: CAP("hit-stop.png") });

    // P2 answers with "/" (their peck key); P2 keys never move P1.
    await stepTicks(page, 30);
    const p1x = (await snap(page)).f[0]!.x;
    await page.keyboard.down("ArrowRight");
    await stepTicks(page, 10);
    await page.keyboard.up("ArrowRight");
    expect((await snap(page)).f[0]!.x).toBe(p1x);

    expect(problems.errors).toEqual([]);
    expect(await problems.cspViolations()).toEqual([]);
  });

  test("CPU vs CPU plays a whole match to the end with every clip loaded", async ({ page }) => {
    const problems = await watchProblems(page);
    await openFight(page, "mode=demo&difficulty=hard&manual=1&debug=1&seed=e2e-cpu");
    expect(await fightCall<number>(page, "clips")).toBe(21);
    let s = await snap(page);
    let shotKo = false;
    for (let i = 0; i < 400 && s.matchWinner < 0; i++) {
      await stepTicks(page, 60);
      s = await snap(page);
      if (!shotKo && s.phase === 2) {
        await page.screenshot({ path: CAP("round-end.png") });
        shotKo = true;
      }
    }
    expect(s.matchWinner).toBeGreaterThanOrEqual(0);
    await stepTicks(page, 30);
    await expect(page.getByTestId("match-end")).toBeVisible();
    await page.screenshot({ path: CAP("match-end.png") });
    const sounds = await fightCall<string[]>(page, "sounds");
    expect(sounds.length).toBeGreaterThan(0);
    expect(problems.errors).toEqual([]);
    expect(await problems.cspViolations()).toEqual([]);
  });

  test("the HUD shows the countdown, names, timer and round", async ({ page }) => {
    await openFight(page, "mode=cpu&difficulty=easy&manual=1&debug=1&seed=e2e-hud");
    await stepTicks(page, 70);
    await expect(page.getByTestId("hud-banner")).toHaveText(/^[123]$/);
    await expect(page.getByTestId("hud-name-0")).toHaveText("YOU");
    await expect(page.getByTestId("hud-name-1")).toHaveText(/CPU/);
    await stepTicks(page, 120);
    await expect(page.getByTestId("hud-timer")).toHaveText("60");
    await page.screenshot({ path: CAP("hud.png") });
  });

  for (const tier of ["rust", "chrome", "gold", "diamond"] as const) {
    test(`tier ${tier} renders`, async ({ page }) => {
      const problems = await watchProblems(page);
      await openFight(page, `mode=2p&tier=${tier}&manual=1&debug=1&seed=e2e-tier-${tier}`);
      await stepTicks(page, 200);
      await page.screenshot({ path: CAP(`tier-${tier}.png`) });
      expect(problems.errors).toEqual([]);
    });
  }

  test("the mode picker starts a fight", async ({ page }) => {
    await page.goto("/play");
    await expect(page.getByTestId("mode-picker")).toBeVisible();
    await page.getByRole("button", { name: "Controls" }).click();
    await expect(page.getByTestId("key-tester")).toBeVisible();
    await page.getByTestId("fight-button").click();
    await expect(page.getByTestId("fight-screen")).toBeVisible();
    await page.waitForFunction(() => (window as unknown as { __cockfight?: { fight?: { ready(): boolean } } }).__cockfight?.fight?.ready() === true);
  });
});
