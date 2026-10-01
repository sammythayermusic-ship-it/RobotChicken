/**
 * Phase 3 pages on a production build with no Supabase configured: the pool
 * panel says payouts start with the coin, /how-it-works reads, /p/<address>
 * answers for an unknown wallet, and none of it logs an error or a CSP
 * violation.
 */
import { expect, test } from "@playwright/test";
import { watchProblems } from "./support/console";

const ALICE = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

test("the landing page's pool panel explains itself without a pool", async ({ page }) => {
  const problems = await watchProblems(page);
  await page.goto("/");
  const pool = page.getByTestId("pool");
  await expect(pool).toHaveAttribute("data-state", "offline");
  await expect(pool).toContainText("Payouts start with the coin");
  await expect(page.getByRole("link", { name: /how it works/i }).first()).toBeVisible();
  expect(problems.errors).toEqual([]);
  expect(await problems.cspViolations()).toEqual([]);
});

test("/how-it-works reads the economy in plain words", async ({ page }) => {
  const problems = await watchProblems(page);
  const res = await page.goto("/how-it-works");
  expect(res?.status()).toBe(200);
  const main = page.getByTestId("how-it-works");
  await expect(main.getByRole("heading", { level: 1 })).toHaveText("HOW IT WORKS");
  for (const h of ["Where the money comes from", "How a win gets paid", "Tiers", "The daily top 10", "Why the pot can't run dry", "Fair play"]) {
    await expect(main.getByRole("heading", { level: 2, name: h })).toBeVisible();
  }
  await expect(main).toContainText("3% creator fee");
  await expect(main).toContainText("70% of every fee goes to players");
  await expect(main).toContainText("5% of it for Rust, 8% for Chrome, 12% for Gold");
  expect(problems.errors).toEqual([]);
  expect(await problems.cspViolations()).toEqual([]);
});

test("/p/<address> answers for a wallet with no ranked matches, and refuses a non-address", async ({ page }) => {
  const problems = await watchProblems(page);
  await page.goto(`/p/${ALICE}`);
  const profile = page.getByTestId("profile");
  await expect(profile).toContainText("No ranked matches for this wallet yet");
  await expect(profile.getByTestId("claim-name")).toBeVisible();
  await page.goto("/p/not-a-wallet");
  await expect(page.getByTestId("profile")).toContainText("That isn't a wallet address");
  expect(problems.errors).toEqual([]);
  expect(await problems.cspViolations()).toEqual([]);
});
