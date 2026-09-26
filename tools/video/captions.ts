/**
 * Renders caption lines to alpha PNGs with the site's body face (the Mac's
 * ffmpeg has no libass). build.ts calls this with a JSON file of lines.
 *   tsx video/captions.ts <lines.json> <outDir>
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Rig, DESKTOP_1X } from "./rig";

const linesFile = process.argv[2];
const outDir = process.argv[3];
if (!linesFile || !outDir) throw new Error("usage: captions.ts <lines.json> <outDir>");
const lines: string[] = JSON.parse(readFileSync(linesFile, "utf8"));
mkdirSync(outDir, { recursive: true });
const cssHref = "file://" + resolve(import.meta.dirname, "cards", "cards.css");

const rig = new Rig({ outRoot: outDir, baseUrl: "" });
await rig.open();
try {
  const ctx = await rig.context(DESKTOP_1X);
  const page = await ctx.newPage();
  for (let i = 0; i < lines.length; i++) {
    const html = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${cssHref}"></head>
<body style="display:block"><div style="position:absolute;left:0;right:0;bottom:64px;display:flex;justify-content:center">
<div style="max-width:1500px;padding:14px 30px;border-radius:14px;background:rgb(10 7 16 / .72);font-size:46px;font-weight:600;line-height:1.25;text-align:center;color:#eae3df;text-shadow:0 2px 0 rgb(0 0 0 / .6)">${(lines[i] ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")}</div></div></body></html>`;
    const f = join(outDir, `cap${String(i).padStart(2, "0")}.html`);
    writeFileSync(f, html);
    await page.goto("file://" + f, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: join(outDir, `cap${String(i).padStart(2, "0")}.png`), omitBackground: true });
  }
  await ctx.close();
} finally {
  await rig.close();
}
console.log(`${lines.length} captions → ${outDir}`);
