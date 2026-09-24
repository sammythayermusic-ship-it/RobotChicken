/**
 * Online play end to end, two browsers against the production game server
 * (open playtest mode, started by playwright.config.ts):
 *   - both queue with a name and are paired into one match;
 *   - their buttons reach the server and both predictions track it;
 *   - one browser vanishes: the other sees the pause and wins by forfeit
 *     after the 10 s grace (spec acceptance);
 *   - the replay page reproduces the match exactly (spec acceptance).
 */
import { expect, test, type Browser, type Page } from "@playwright/test";
import { watchProblems, type Problems } from "./support/console";

interface NetView {
  side: 0 | 1;
  status: string;
  present: number;
  confirmedTick: number;
  confirmedHash: string;
  stats: { desyncs: number; rollbacks: number };
}

type W = Window & {
  __cockfight?: {
    fight?: { ready(): boolean; net(): NetView | null; setInput?(p: 0 | 1, m: number): void; hash(): string; stepTicks?(n: number): void };
    replay?: { ticks: number; finalHash: string; winnerSide: number | null; reason: string };
  };
};

const QUERY = "mode=online&debug=1&arena=0&quality=low";

async function player(browser: Browser, name: string): Promise<{ page: Page; problems: Problems; close: () => Promise<void> }> {
  const ctx = await browser.newContext({ viewport: { width: 960, height: 600 } });
  const page = await ctx.newPage();
  const problems = await watchProblems(page);
  await page.goto(`/play?${QUERY}`);
  await expect(page.getByTestId("online-lobby")).toBeVisible();
  // Open mode: a name is all it takes.
  await expect(page.getByTestId("open-form")).toBeVisible({ timeout: 20_000 });
  await page.getByLabel("Your fighter's name").fill(name);
  await page.getByTestId("find-match").click();
  return { page, problems, close: () => ctx.close() };
}

const net = (page: Page) => page.evaluate(() => (window as W).__cockfight?.fight?.net() ?? null);

test.describe("online", () => {
  test.describe.configure({ timeout: 240_000 });

  test("two browsers meet, a vanished player forfeits after the grace, and the replay reproduces the match", async ({ browser }) => {
    const alice = await player(browser, "Alice");
    await expect(alice.page.getByTestId("queue")).toBeVisible();
    const bob = await player(browser, "Bob");

    // Paired: each sees the other's name, then the fight loads.
    await expect(alice.page.getByTestId("matched")).toContainText("VS Bob");
    await expect(bob.page.getByTestId("matched")).toContainText("VS Alice");
    for (const p of [alice.page, bob.page]) {
      await expect(p.getByTestId("fight-screen")).toBeVisible({ timeout: 30_000 });
      await p.waitForFunction(() => (window as W).__cockfight?.fight?.ready() === true, null, { timeout: 120_000 });
    }
    // Both loaded: the server starts the match.
    for (const p of [alice.page, bob.page]) {
      await p.waitForFunction(() => (window as W).__cockfight?.fight?.net()?.status === "live", null, { timeout: 30_000 });
    }
    const [na, nb] = [(await net(alice.page))!, (await net(bob.page))!];
    expect(new Set([na.side, nb.side])).toEqual(new Set([0, 1]));

    // Alice walks toward Bob and pecks; Bob holds block.
    await alice.page.evaluate((side) => (window as W).__cockfight!.fight!.setInput!(side, side === 0 ? 2 | 16 : 1 | 16), na.side);
    await bob.page.evaluate((side) => (window as W).__cockfight!.fight!.setInput!(side, 8), nb.side);
    // Past the 3 s countdown and into the fight, on the server's clock.
    await alice.page.waitForFunction(() => ((window as W).__cockfight?.fight?.net()?.confirmedTick ?? 0) > 360, null, { timeout: 60_000 });
    for (const p of [alice.page, bob.page]) expect((await net(p))!.stats.desyncs).toBe(0);

    // Bob's browser vanishes (no goodbye): Alice sees the pause, then wins by forfeit.
    await bob.close();
    const gone = Date.now();
    await expect(alice.page.getByTestId("online-paused")).toBeVisible({ timeout: 10_000 });
    await expect(alice.page.getByTestId("online-result-title")).toHaveText("YOU WIN", { timeout: 20_000 });
    expect(Date.now() - gone).toBeGreaterThan(9_000);
    await expect(alice.page.getByTestId("online-result")).toContainText("Bob left the match");
    await expect(alice.page.getByTestId("online-elo")).toContainText("(+");

    // The replay page: verified headless, and played back in the engine to the stored final state.
    const link = alice.page.getByTestId("replay-link");
    await expect(link).toBeVisible();
    const href = (await link.getAttribute("href"))!;
    expect(href).toMatch(/^\/m\/[0-9a-f-]{36}$/);
    const viewer = alice.page;
    await viewer.goto(`${href}?debug=1&manual=1&arena=0&quality=low`);
    await expect(viewer.getByTestId("replay-verified")).toHaveAttribute("data-ok", "1", { timeout: 30_000 });
    await expect(viewer.getByTestId("replay-result")).toContainText("Alice wins by forfeit");
    await viewer.waitForFunction(() => (window as W).__cockfight?.fight?.ready() === true, null, { timeout: 120_000 });
    const { ticks, finalHash } = await viewer.evaluate(() => (window as W).__cockfight!.replay!);
    await viewer.evaluate((n) => (window as W).__cockfight!.fight!.stepTicks!(n), ticks + 30);
    expect(await viewer.evaluate(() => (window as W).__cockfight!.fight!.hash())).toBe(finalHash);
    // Online play, the result and the replay page all run clean under the CSP, with no uncaught errors.
    expect(await alice.problems.cspViolations()).toEqual([]);
    expect(alice.problems.errors.filter((e) => /Content Security Policy|pageerror/.test(e))).toEqual([]);
    await alice.close();
  });

  test("an unknown match id shows a clear not-found", async ({ page }) => {
    await page.goto("/m/00000000-0000-4000-8000-000000000000");
    await expect(page.getByTestId("replay-status")).toHaveText("NO SUCH MATCH", { timeout: 20_000 });
  });

  test("the leaderboard loads (playtest standings from the game server)", async ({ page }) => {
    await page.goto("/leaderboard");
    await expect(page.getByRole("heading", { name: "LEADERBOARD" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "TODAY" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText(/Loading/)).toHaveCount(0, { timeout: 20_000 });
  });
});
