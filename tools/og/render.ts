/**
 * Renders the link-preview card (tools/og/og.html, 1200×630) to
 * apps/web/public/og.png. Run: pnpm --filter @cockfight/tools og (the logo is art/brand/v1-mecha/logo-B).
 */
import { chromium } from "@playwright/test";
import { resolve } from "node:path";

const here = resolve(import.meta.dirname);
const out = resolve(here, "../../apps/web/public/og.png");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.goto("file://" + resolve(here, "og.html"), { waitUntil: "networkidle" });
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: out, type: "png" });
await browser.close();
console.log("wrote", out);
