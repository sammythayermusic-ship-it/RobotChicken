/**
 * pnpm --filter @cockfight/tools video:capture [shot…]   (no names = every shot)
 *   VIDEO_BASE_URL   site to shoot (default https://cockfightsol.fun)
 *   VIDEO_OUT        output root (default "<repo>/Claude outputs/video")
 *   VIDEO_DRY=1      step and log events only (tune a script), no frames
 * `video:capture sounds` exports the game's procedural sounds as WAVs to <out>/sfx.
 * Fights add mode=2p&manual=1&debug=1&seed=video to /play so both chickens are
 * scripted and the sim only moves when the rig steps it.
 */
import { join, resolve } from "node:path";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { Rig, ensureDir, type ShotResult } from "./rig";
import { SHOTS, type ShotDef } from "./shots";

const repo = resolve(import.meta.dirname, "../..");
const outRoot = ensureDir(process.env.VIDEO_OUT ?? join(repo, "Claude outputs", "video"));
const baseUrl = process.env.VIDEO_BASE_URL ?? "https://cockfightsol.fun";
const dry = process.env.VIDEO_DRY === "1";
const wanted = process.argv.slice(2);
const list = wanted.length ? SHOTS.filter((s) => wanted.includes(s.name)) : SHOTS;
if (wanted.length && wanted[0] !== "sounds" && list.length !== wanted.length) {
  const known = new Set(SHOTS.map((s) => s.name));
  throw new Error("unknown shot(s): " + wanted.filter((w) => !known.has(w)).join(", "));
}

async function shoot(rig: Rig, s: ShotDef): Promise<ShotResult> {
  if (s.kind === "fight") {
    const q = "mode=2p&manual=1&debug=1&seed=video&" + (dry ? "quality=low&arena=0" : "quality=high") + (s.query ? "&" + s.query : "");
    return rig.fight(s.name, { url: "/play?" + q, viewport: s.viewport, script: s.script, ticks: s.ticks, from: s.from });
  }
  if (s.kind === "card") return rig.card(s.name, { file: join(import.meta.dirname, "cards", s.file), frames: s.frames });
  if (s.kind === "still") return rig.still(s.name, { url: s.url, viewport: s.viewport, fullPage: s.fullPage });
  return rig.live(s.name, { url: s.url, viewport: s.viewport, seconds: s.seconds, fps: s.fps });
}

if (wanted[0] === "sounds") {
  const rig0 = new Rig({ outRoot, baseUrl });
  await rig0.open();
  try {
    const names = await rig0.sounds(join(outRoot, "sfx"));
    console.log(`exported ${names.length} sounds → ${join(outRoot, "sfx")}`);
  } finally {
    await rig0.close();
  }
  process.exit(0);
}
const rig = new Rig({ outRoot, baseUrl, headless: process.env.VIDEO_HEADLESS === "1", dry });
await rig.open();
const indexPath = join(outRoot, "shots.json");
// Re-read before every write: several capture processes may run at once.
const readIndex = (): Record<string, ShotResult & { note?: string }> => (existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, "utf8")) : {});
try {
  for (const s of list) {
    process.stdout.write(`▶ ${s.name} … `);
    const r = await shoot(rig, s);
    const index = readIndex();
    index[s.name] = { ...r, note: s.note };
    writeFileSync(indexPath, JSON.stringify(index, null, 2));
    console.log(`${r.frames} frames, ${r.seconds.toFixed(0)}s → ${r.file}`);
  }
} finally {
  await rig.close();
}
