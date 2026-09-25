/**
 * pnpm assets:bake [glb]   re-bake packages/sim/data/hitboxes.json (default: the glb it already tracks)
 * pnpm assets:bake --check re-bake in memory; exit 1 if the committed file differs at all
 */
import { HITBOXES_JSON, readHitboxes, trackedGlb, userPath, type HitboxesFile } from "../assets/gltf";
import { bakeFile, checkHitboxes, writeHitboxes } from "../assets/bake";
import { cli, parseArgs } from "./main";

cli(async (argv) => {
  const { flags, positional } = parseArgs(argv, ["--check"], "usage: pnpm assets:bake [glb] | pnpm assets:bake --check");
  if (flags.has("--check")) {
    if (positional.length) throw new Error("--check always re-bakes the glb hitboxes.json names in source.file");
    const r = await checkHitboxes();
    if (r.ok) {
      console.log(`${HITBOXES_JSON} matches a fresh bake of ${readHitboxes().source.file}`);
      return 0;
    }
    console.error(`${HITBOXES_JSON} is stale:\n  ${r.problems.join("\n  ")}\nrun: pnpm assets:bake`);
    return 1;
  }
  let current: HitboxesFile | null = null;
  try {
    current = readHitboxes();
  } catch {
    // A broken file is exactly what a re-bake fixes; fall back to the placeholder.
  }
  const glb = positional[0] ? userPath(positional[0]) : trackedGlb(current);
  const { hitboxes, text } = await bakeFile(glb);
  writeHitboxes(text);
  const clips = Object.keys(hitboxes.clips).length;
  console.log(`baked ${clips} clips from ${hitboxes.source.file} (sha256 ${hitboxes.source.sha256.slice(0, 12)}) into ${HITBOXES_JSON}`);
  console.log("rulesHash changes with hitboxes.json: re-bless the goldens (pnpm replay:golden --bless) and say why in the commit");
  return 0;
});
