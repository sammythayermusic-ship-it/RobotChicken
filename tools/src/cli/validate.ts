/**
 * pnpm assets:validate [glb] [--json] [--arena[=arena.glb]]
 *
 * Validates the chicken glb (default: the one hitboxes.json tracks) and prints
 * the first-load table. --arena also validates Sammy's arena (default
 * apps/web/public/models/arena.glb with arena_lightmap.ktx2 next to it) and
 * skips cleanly when there is none. Exit 1 on any error.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { validateArenaFile } from "../assets/arena";
import { ARENA_GLB, fromRepo, readHitboxes, toRepo, trackedGlb, userPath, type HitboxesFile } from "../assets/gltf";
import { formatReport, validateFile, type ValidateReport } from "../assets/validate";
import { cli, parseArgs } from "./main";

const USAGE = "usage: pnpm assets:validate [glb] [--json] [--arena[=arena.glb]]";

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

  let arena: ValidateReport | undefined;
  let skipped: string | undefined;
  if (flags.has("--arena")) {
    const path = values.has("--arena") ? userPath(values.get("--arena")!) : fromRepo(ARENA_GLB);
    if (existsSync(path)) arena = await validateArenaFile(path, join(dirname(path), "arena_lightmap.ktx2"));
    else skipped = `arena: no ${toRepo(path)} (the procedural junkyard needs no files); arena rules skipped`;
  }

  if (flags.has("--json")) {
    const arenaJson = arena ?? (skipped ? { skipped } : undefined);
    console.log(JSON.stringify(arenaJson ? { ...chicken, arena: arenaJson } : chicken, null, 2));
  } else {
    console.log(formatReport(chicken));
    if (arena) console.log(`\n${formatReport(arena)}`);
    if (skipped) console.log(skipped);
  }
  return chicken.ok && (arena?.ok ?? true) ? 0 : 1;
});
