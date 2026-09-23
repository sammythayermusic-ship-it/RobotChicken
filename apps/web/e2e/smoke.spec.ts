import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type APIRequestContext, type ConsoleMessage, type Page } from "@playwright/test";
import type { ShowcaseDebug } from "../src/game/engine/debug";
import { watchProblems } from "./support/console";

const MODEL = "/models/chicken_placeholder.glb";
const LANDING_PNG = fileURLToPath(new URL("../../../docs/captures/phase-0/landing.png", import.meta.url));

/**
 * Until workstream A's Blender placeholder is committed the glb 404s and the
 * showcase falls back to box chickens. Chrome logs that 404 as a console
 * error, so exactly that message is excused, and only while the file is
 * genuinely missing.
 */
async function modelState(request: APIRequestContext) {
  const present = (await request.head(MODEL)).ok();
  const ignore = (m: ConsoleMessage) => !present && m.location().url.endsWith(MODEL) && /\b404\b/.test(m.text());
  return { present, ignore };
}

/** Plain copy of the read-only debug handle (its fields are getters). */
function showcase(page: Page): Promise<ShowcaseDebug | null> {
  return page.evaluate(() => {
    const s = window.__cockfight?.showcase;
    return s ? { ready: s.ready, fallback: s.fallback, clips: [...s.clips], error: s.error } : null;
  });
}

/**
 * How many objects built by the page's `ctor` are still alive after a full
 * garbage collection (Chromium only: it asks V8 through CDP). The results are
 * held in an object group that is released before returning, so counting
 * never keeps anything alive itself.
 */
async function liveObjects(page: Page, ctor: string): Promise<number> {
  const cdp = await page.context().newCDPSession(page);
  const objectGroup = "live-objects";
  try {
    await cdp.send("HeapProfiler.collectGarbage");
    const { result: proto } = await cdp.send("Runtime.evaluate", { expression: `${ctor}.prototype`, objectGroup });
    const { objects } = await cdp.send("Runtime.queryObjects", { prototypeObjectId: proto.objectId as string, objectGroup });
    const { result } = await cdp.send("Runtime.callFunctionOn", {
      objectId: objects.objectId as string,
      functionDeclaration: "function () { return this.length; }",
      returnByValue: true,
      objectGroup,
    });
    return result.value as number;
  } finally {
    await cdp.send("Runtime.releaseObjectGroup", { objectGroup });
    await cdp.detach();
  }
}

async function expectShowcaseReady(page: Page, modelPresent: boolean): Promise<void> {
  await page.waitForFunction(() => window.__cockfight?.showcase?.ready === true, null, { timeout: 30_000 });
  const state = await showcase(page);
  if (modelPresent) {
    expect(state?.fallback, `glb present but fell back: ${state?.error}`).toBe(false);
    expect(state?.clips).toContain("idle");
  } else {
    expect(state?.fallback).toBe(true);
  }
}

test.describe("landing", () => {
  test("renders the showcase with zero console errors and zero CSP violations", async ({ page, request }) => {
    const model = await modelState(request);
    const problems = await watchProblems(page, { ignore: model.ignore });

    await page.goto("/");
    // Guard against reuseExistingServer finding some other app on the port.
    await expect(page).toHaveTitle("COCKFIGHT");
    await expect(page.getByRole("heading", { level: 1, name: "COCKFIGHT" })).toBeVisible();
    await expect(page.getByText("Hold to play. Win to earn.")).toBeVisible();
    await expect(page.getByLabel("Solana wallet address")).toBeDisabled();
    await expect(page.getByTestId("rules-hash")).toHaveText(/^[0-9a-f]{16}$/);

    const canvas = page.locator("canvas");
    await expect(canvas).toHaveCount(1);
    await expect(canvas).toBeVisible();
    await expectShowcaseReady(page, model.present);

    // Let the idle play and the camera sway a little, then prove the canvas is
    // actually drawing: a uniform frame compresses to a tiny PNG.
    await page.waitForTimeout(1500);
    const frame = await canvas.screenshot();
    expect(frame.byteLength, "canvas looks blank").toBeGreaterThan(30_000);

    fs.mkdirSync(path.dirname(LANDING_PNG), { recursive: true });
    await page.screenshot({ path: LANDING_PNG, fullPage: true });

    expect(problems.errors).toEqual([]);
    expect(await problems.cspViolations()).toEqual([]);
  });

  test("the shipped policy holds when enforced", async ({ page, request }) => {
    // Report-only hides whole classes of breakage: Chrome neither blocks nor
    // reports wasm compilation or eval under a report-only policy. Promote the
    // exact header to enforcing for this page load, so the Draco decoder's
    // worker and wasm (whenever the glb exists) must work under it.
    const model = await modelState(request);
    const problems = await watchProblems(page, { ignore: model.ignore });
    let enforced = "";
    await page.route("/", async (route) => {
      const res = await route.fetch();
      const headers = res.headers();
      enforced = headers["content-security-policy-report-only"] ?? "";
      delete headers["content-security-policy-report-only"];
      headers["content-security-policy"] = enforced;
      await route.fulfill({ response: res, headers });
    });

    await page.goto("/");
    expect(enforced).toContain("'wasm-unsafe-eval'");
    await expectShowcaseReady(page, model.present);
    expect(problems.errors).toEqual([]);
    expect(await problems.cspViolations()).toEqual([]);
  });

  test("FIGHT disposes the showcase, and coming back builds a fresh one", async ({ page, request }) => {
    const model = await modelState(request);
    const problems = await watchProblems(page, { ignore: model.ignore });
    await page.goto("/");
    await expectShowcaseReady(page, model.present);
    const first = await page.locator("canvas").elementHandle();

    await page.getByRole("link", { name: "FIGHT" }).click();
    await expect(page).toHaveURL(/\/play$/);
    await expect(page.getByText(/local fighter lands in Phase 1/)).toBeVisible();
    await expect(page.locator("canvas")).toHaveCount(0);
    expect(await showcase(page)).toBeNull();

    await page.goBack();
    await expectShowcaseReady(page, model.present);
    await expect(page.locator("canvas")).toHaveCount(1);
    // A force-lost context stays lost: the new showcase must own a new canvas.
    expect(await page.locator("canvas").evaluate((c, old) => c !== old, first)).toBe(true);

    expect(problems.errors).toEqual([]);
    expect(await problems.cspViolations()).toEqual([]);
  });

  test("round trips through /play leave no dead renderer, canvas or context alive", async ({ page, request, browserName }) => {
    test.skip(browserName !== "chromium", "counts live objects through CDP");
    // three r186 keeps one module-level DFG LUT texture, and every renderer
    // that uploads it adds a 'dispose' listener capturing its own GL state.
    // renderer.dispose() never removes it, so without disposeRenderer() each
    // visit to the landing page left one canvas and one context behind.
    const model = await modelState(request);
    await page.goto("/");
    await expectShowcaseReady(page, model.present);
    const trips = 3;
    for (let i = 0; i < trips; i++) {
      await page.getByRole("link", { name: "FIGHT" }).click();
      await expect(page).toHaveURL(/\/play$/);
      await expect(page.locator("canvas")).toHaveCount(0);
      await page.goBack();
      await expectShowcaseReady(page, model.present);
    }
    // Only the showcase on screen now.
    expect(await liveObjects(page, "HTMLCanvasElement")).toBe(1);
    expect(await liveObjects(page, "WebGL2RenderingContext")).toBe(1);
  });
});

test("/play responds 200 with no console errors", async ({ page }) => {
  const problems = await watchProblems(page);
  const res = await page.goto("/play");
  expect(res?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  expect(problems.errors).toEqual([]);
  expect(await problems.cspViolations()).toEqual([]);
});

test("/dev/net is not served by a production build", async ({ request }) => {
  expect((await request.get("/dev/net")).status()).toBe(404);
});

test("the CSP watcher does see violations (so zero means zero)", async ({ page }) => {
  const problems = await watchProblems(page);
  await page.goto("/play");
  // Production script-src has no 'unsafe-eval', so a string timer violates it.
  // Report-only: the timer still runs and nothing is fetched; the page only
  // reports it, through the event and a console line.
  await page.evaluate(() => {
    const s = document.createElement("script");
    s.textContent = "setTimeout('window.__cspProbe = 4', 0);";
    document.head.append(s);
  });
  await expect.poll(async () => (await problems.cspViolations()).map((v) => [v.directive, v.disposition])).toEqual([["script-src", "report"]]);
  expect(await page.evaluate(() => (window as Window & { __cspProbe?: number }).__cspProbe)).toBe(4);
  await expect.poll(() => problems.errors.some((e) => e.includes("Content Security Policy"))).toBe(true);
});
