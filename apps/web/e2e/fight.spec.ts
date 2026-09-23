import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { watchProblems } from "./support/console";
import { fightCall, openFight, snap, stepTicks, waitForMatch } from "./support/fight";
import { liveObjects } from "./support/heap";

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
    // REMATCH has focus, and Space (a bound game key) must press it rather than go to the fight.
    await expect(page.getByRole("button", { name: /REMATCH/ })).toBeFocused();
    await page.keyboard.press("Space");
    await waitForMatch(page, "e2e-cpu-1");
    await expect(page.getByTestId("match-end")).toBeHidden();
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
    // The selection is announced, not shown by colour only.
    const cpu = page.getByRole("button", { name: "VS CPU" });
    const versus = page.getByRole("button", { name: /2 PLAYERS/ });
    await expect(cpu).toHaveAttribute("aria-pressed", "true");
    await expect(versus).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByRole("group", { name: "CPU" }).getByRole("button", { pressed: true })).toHaveText("NORMAL");
    await expect(page.getByRole("group", { name: /Look/ }).getByRole("button", { pressed: true })).toHaveText("RUST");
    await versus.click();
    await expect(versus).toHaveAttribute("aria-pressed", "true");
    await expect(cpu).toHaveAttribute("aria-pressed", "false");

    await page.getByRole("button", { name: "Controls" }).click();
    const tester = page.getByTestId("key-tester");
    await expect(tester).toBeVisible();
    // Testing peck keys must not press the Controls toggle (Space on release, Enter on press).
    await page.keyboard.down("KeyA");
    await page.keyboard.down("Space");
    await expect(tester).toContainText("KeyA");
    await expect(tester).toContainText("Space");
    await page.keyboard.up("Space");
    await page.keyboard.up("KeyA");
    await page.keyboard.press("Enter");
    await page.keyboard.press("NumpadEnter");
    await expect(tester).toBeVisible();

    await page.getByTestId("fight-button").click();
    await expect(page.getByTestId("fight-screen")).toBeVisible();
    await page.waitForFunction(() => (window as unknown as { __cockfight?: { fight?: { ready(): boolean } } }).__cockfight?.fight?.ready() === true);
  });

  test("restarts, quit-and-fight and rematches start clean and leave one live renderer", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "counts live objects through CDP");
    test.setTimeout(240_000);
    const problems = await watchProblems(page);
    const dialog = page.getByRole("dialog", { name: "Paused" });
    const seed = "e2e-restarts";
    // Arena on (the default): its factory used to chain every engine to the one before it.
    await openFight(page, `mode=demo&difficulty=hard&manual=1&debug=1&seed=${seed}`);
    // One fight's worth: its WebGL canvas, plus the arena's crowd atlas (a detached 2D canvas).
    const canvasesPerFight = await liveObjects(page, "HTMLCanvasElement");
    expect(await liveObjects(page, "WebGL2RenderingContext")).toBe(1);
    let round = 0;

    /** The HUD of a fight that hasn't ticked yet (manual mode): nothing carried over. */
    const expectFreshHud = async () => {
      await expect(dialog).toBeHidden();
      await expect(page.getByTestId("match-end")).toBeHidden();
      expect(await fightCall<boolean>(page, "paused")).toBe(false);
      const health = page.getByRole("meter", { name: /health$/ });
      const heat = page.getByRole("meter", { name: /heat$/ });
      for (const side of [0, 1]) {
        await expect(health.nth(side)).toHaveAttribute("aria-valuenow", "100");
        await expect(heat.nth(side)).toHaveAttribute("aria-valuenow", "0");
      }
      await expect(page.getByLabel("0 rounds won")).toHaveCount(2);
      await expect(page.getByText("ROUND 1", { exact: true })).toBeVisible();
      await expect(page.getByTestId("hud-banner")).toHaveCount(0);
    };

    // RESTART from the pause menu, three times.
    for (let i = 0; i < 3; i++) {
      await stepTicks(page, 400);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "RESTART" }).click();
      await waitForMatch(page, `${seed}-${++round}`);
      await expectFreshHud();
    }

    // QUIT, then FIGHT from the mode picker (vs CPU, the picker's default).
    await stepTicks(page, 400);
    await page.keyboard.press("Escape");
    await dialog.getByRole("button", { name: "QUIT" }).click();
    await page.getByTestId("fight-button").click();
    await waitForMatch(page, `${seed}-${++round}`);
    await expectFreshHud();

    // Play the match out (the idle player loses), then hold R: key repeat must start one rematch, not six.
    let s = await snap(page);
    for (let i = 0; i < 200 && s.matchWinner < 0; i++) {
      await stepTicks(page, 300);
      s = await snap(page);
    }
    expect(s.matchWinner).toBeGreaterThanOrEqual(0);
    await expect(page.getByTestId("match-end")).toBeVisible();
    // Held R (auto-repeat keydowns), then a second press while the rematch loads. Fired in one
    // task, so they all land before React re-renders: Playwright's own key events each wait
    // for the page, which hides the problem once the new fight has reset the HUD.
    await page.evaluate(() => {
      const r = (repeat: boolean) => window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyR", key: "r", repeat }));
      r(false);
      for (let i = 0; i < 4; i++) r(true);
      r(false);
    });
    await page.waitForFunction(
      (prev) => {
        const f = (window as unknown as { __cockfight?: { fight?: { ready(): boolean; matchId(): string } } }).__cockfight?.fight;
        return !!f && f.matchId() !== prev && f.ready();
      },
      `${seed}-${round}`,
      { timeout: 60_000 },
    );
    expect(await fightCall<string>(page, "matchId"), "one rematch for the whole burst").toBe(`${seed}-${++round}`);
    await expectFreshHud();
    await stepTicks(page, 10);
    expect(await fightCall<string>(page, "matchId")).toBe(`${seed}-${round}`);

    // Six fights later: only the one on screen still holds canvases and a WebGL context.
    expect(await liveObjects(page, "WebGL2RenderingContext")).toBe(1);
    expect(await liveObjects(page, "HTMLCanvasElement")).toBe(canvasesPerFight);
    expect(problems.errors).toEqual([]);
  });

  test("the pause menu works from the keyboard in 2P, and keys pressed while paused do nothing after", async ({ page }) => {
    const problems = await watchProblems(page);
    const dialog = page.getByRole("dialog", { name: "Paused" });
    await openFight(page, "mode=2p&manual=1&debug=1&seed=e2e-menu-keys&arena=0");
    await stepTicks(page, 181);

    // RESUME is focused; Enter is also a P2 peck key, and must press the button.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "RESUME" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden();
    expect(await fightCall<boolean>(page, "paused")).toBe(false);

    // Space (P1 peck) toggles the Sound checkbox and presses RESUME.
    await page.keyboard.press("Escape");
    const sound = dialog.getByRole("checkbox");
    await sound.focus();
    await page.keyboard.press("Space");
    await expect(sound).not.toBeChecked();
    await page.keyboard.press("Space");
    await expect(sound).toBeChecked();
    await dialog.getByRole("button", { name: "RESUME" }).focus();
    await page.keyboard.press("Space");
    await expect(dialog).toBeHidden();

    // Keys pressed on the menu (focus on no control) must not latch into the first tick after resuming.
    const before = await snap(page);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await page.mouse.click(8, 400); // the backdrop: focus leaves RESUME
    await page.keyboard.press("Space");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await stepTicks(page, 1);
    const after = await snap(page);
    expect(after.f[0]!.st, "P1 pecked from a key pressed while paused").toBe(before.f[0]!.st);
    expect(after.f[1]!.st, "P2 jumped from a key pressed while paused").toBe(before.f[1]!.st);
    expect(problems.errors).toEqual([]);
  });

  test("the screen-shake setting reaches every new fight (reduced motion starts at 30%)", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openFight(page, "mode=cpu&manual=1&debug=1&seed=e2e-shake&arena=0");
    expect(await fightCall<number>(page, "shake")).toBeCloseTo(0.3);
    await page.keyboard.press("Escape");
    await page.getByLabel("Screen shake").selectOption("0");
    expect(await fightCall<number>(page, "shake")).toBe(0);
    await page.getByRole("button", { name: "RESTART" }).click();
    await waitForMatch(page, "e2e-shake-1");
    await expect(page.getByLabel("Screen shake")).toHaveCount(0); // the menu closed with the old fight
    expect(await fightCall<number>(page, "shake")).toBe(0);
  });
});
