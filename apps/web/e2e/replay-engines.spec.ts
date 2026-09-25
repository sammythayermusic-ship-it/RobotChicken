import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

/**
 * Determinism across JavaScript engines: every golden replay, run inside the
 * browser (V8 in Chromium, SpiderMonkey in Firefox, JavaScriptCore in WebKit),
 * must end on its committed state hash. Phase 2 runs client prediction in
 * all three, so a divergence here would mean desyncs in online play.
 */
const GOLDEN = fileURLToPath(new URL("../../../packages/sim/test/golden/", import.meta.url));
const replays = fs
  .readdirSync(GOLDEN)
  .filter((f) => f.endsWith(".replay.json"))
  .sort()
  .map((f) => ({ name: f.replace(".replay.json", ""), data: JSON.parse(fs.readFileSync(path.join(GOLDEN, f), "utf8")) as { finalHash: string; rulesHash: string } }));

test("golden replays give the committed hashes in this engine", async ({ page, browserName }) => {
  test.setTimeout(180_000);
  await page.goto("/play?debug=1");
  await page.waitForFunction(() => Boolean((window as unknown as { __cockfight?: { sim?: unknown } }).__cockfight?.sim));
  const rulesHash = await page.evaluate(() => (window as unknown as { __cockfight: { sim: { rulesHash: string } } }).__cockfight.sim.rulesHash);
  for (const r of replays) {
    expect(r.data.rulesHash, `${r.name}: stale golden`).toBe(rulesHash);
    const res = await page.evaluate((data) => (window as unknown as { __cockfight: { sim: { run(r: unknown): { hash: string } } } }).__cockfight.sim.run(data), r.data);
    expect(res.hash, `${r.name} in ${browserName}`).toBe(r.data.finalHash);
  }
});
