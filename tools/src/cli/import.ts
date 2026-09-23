/**
 * pnpm assets:import --blend <file.blend> [--out apps/web/public/models/chicken.glb] [--retime] [--hitboxes <json>]
 *
 * Export the hero chicken with headless Blender, validate it, and bake
 * packages/sim/data/hitboxes.json from it (see assets/import.ts). Exit 1 at
 * the first failing stage, with what to fix; 3 when Blender is not installed.
 * --hitboxes writes the bake elsewhere (a dry run: the game keeps what it loads).
 */
import { HERO_GLB, fromRepo, userPath } from "../assets/gltf";
import { importChicken } from "../assets/import";
import { cli, parseArgs } from "./main";

const USAGE =
  "usage: pnpm assets:import --blend <file.blend> [--out apps/web/public/models/chicken.glb] [--retime] [--hitboxes <json>]\n" +
  "  --retime    the .blend is not at 60 fps: scale every clip to 60 fps (keeping its real-time length) instead of failing\n" +
  "  --hitboxes  write the bake here instead of packages/sim/data/hitboxes.json (a dry run)";

cli(async (argv) => {
  const { flags, values, positional } = parseArgs(argv, ["--retime"], USAGE, ["--blend", "--out", "--hitboxes"]);
  // `pnpm assets:import art/chicken.blend` works too.
  const blend = values.get("--blend") ?? (positional.length === 1 ? positional[0] : undefined);
  if (!blend || positional.length > (values.has("--blend") ? 0 : 1)) throw new Error(USAGE);
  const result = await importChicken({
    blend: userPath(blend),
    out: values.has("--out") ? userPath(values.get("--out")!) : fromRepo(HERO_GLB),
    retime: flags.has("--retime"),
    hitboxes: values.has("--hitboxes") ? userPath(values.get("--hitboxes")!) : undefined,
  });
  return result.ok ? 0 : 1;
});
