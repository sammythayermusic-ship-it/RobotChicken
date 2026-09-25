/**
 * pnpm assets:validate [glb] [--json] [--arena=<arena.glb>]
 *
 * Validates the chicken glb (default: the one hitboxes.json tracks) and prints
 * the first-load table. It also validates Sammy's arena whenever there is one
 * (apps/web/public/models/arena.glb, with arena_lightmap.ktx2 next to it, or
 * the file --arena= names) and skips those rules cleanly when there is none.
 * A bare --arena is accepted and changes nothing. Exit 1 on any error.
 */
import { validateArenaIfPresent } from "../assets/arena";
import { readHitboxes, toRepo, trackedGlb, userPath, type HitboxesFile } from "../assets/gltf";
import { formatReport, validateFile } from "../assets/validate";
import { cli, parseArgs } from "./main";

const USAGE = "usage: pnpm assets:validate [glb] [--json] [--arena=<arena.glb>]  (the arena rules run whenever apps/web/public/models/arena.glb exists)";

cli(async (argv) => {
  const { flags, values, positional } = parseArgs(argv, ["--json", "--arena"], USAGE);
  if (positional.length > 1) throw new Error(USAGE);
  let hitboxes: HitboxesFile | null = null;
  try {
    hitboxes = readHitboxes();
  } catch (e) {
    console.error(`warning: cannot read packages/sim/data/hitboxes.json (${(e as Error).message}); skipping the hitboxes checks`);
  }
  const file = positional[0] ? userPath(positional[0]) : trackedGlb(hitboxes);
  const chicken = await validateFile(file, { hitboxes, file: toRepo(file) });
  const arena = await validateArenaIfPresent(values.has("--arena") ? userPath(values.get("--arena")!) : undefined);

  if (flags.has("--json")) {
    console.log(JSON.stringify({ ...chicken, arena: "report" in arena ? arena.report : arena }, null, 2));
  } else {
    console.log(formatReport(chicken));
    console.log("report" in arena ? `\n${formatReport(arena.report)}` : arena.skipped);
  }
  return chicken.ok && ("report" in arena ? arena.report.ok : true) ? 0 : 1;
});
