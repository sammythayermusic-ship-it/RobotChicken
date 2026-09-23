/**
 * pnpm assets:placeholder: build the placeholder chicken in headless Blender,
 * export it to apps/web/public/models/chicken_placeholder.glb, validate it,
 * then re-bake hitboxes.json (unless hitboxes.json tracks a different glb,
 * such as the hero chicken, in which case the bake is left alone).
 */
import { PLACEHOLDER_GLB, PLACEHOLDER_SCRIPT, fromRepo, readHitboxes, type HitboxesFile } from "../assets/gltf";
import { formatReport, validateFile } from "../assets/validate";
import { bakeFile, writeHitboxes } from "../assets/bake";
import { parseReport, runBlender } from "../blender/run";
import { cli, parseArgs } from "./main";

cli(async (argv) => {
  parseArgs(argv, [], "usage: pnpm assets:placeholder");
  const out = fromRepo(PLACEHOLDER_GLB);
  const run = runBlender(fromRepo(PLACEHOLDER_SCRIPT), ["--out", out], { capture: true });
  if (run.status !== 0 || !parseReport(run.stdout)) {
    console.error(`placeholder build failed (blender exit ${run.status}); see CF_ERROR above`);
    return run.status || 1;
  }

  // hitboxes.json is about to be re-baked, so its sha256 is not checked here.
  const report = await validateFile(out, { hitboxes: null, file: PLACEHOLDER_GLB });
  console.log(formatReport(report));
  if (!report.ok) return 1;

  let current: HitboxesFile | null = null;
  try {
    current = readHitboxes();
  } catch {
    // unreadable: re-bake from the placeholder below
  }
  if (current?.source.file && current.source.file !== PLACEHOLDER_GLB) {
    console.log(`hitboxes.json tracks ${current.source.file}, not the placeholder; leaving it alone`);
    return 0;
  }
  const { hitboxes, text } = await bakeFile(out);
  writeHitboxes(text);
  console.log(`baked ${Object.keys(hitboxes.clips).length} clips into packages/sim/data/hitboxes.json (glb sha256 ${hitboxes.source.sha256.slice(0, 12)})`);
  return 0;
});
