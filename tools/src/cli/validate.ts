/** pnpm assets:validate [glb] [--json]: defaults to the glb hitboxes.json tracks. Exit 1 on any error. */
import { readHitboxes, toRepo, trackedGlb, userPath, type HitboxesFile } from "../assets/gltf";
import { formatReport, validateFile } from "../assets/validate";
import { cli, parseArgs } from "./main";

cli(async (argv) => {
  const { flags, positional } = parseArgs(argv, ["--json"], "usage: pnpm assets:validate [glb] [--json]");
  let hitboxes: HitboxesFile | null = null;
  try {
    hitboxes = readHitboxes();
  } catch (e) {
    console.error(`warning: cannot read packages/sim/data/hitboxes.json (${(e as Error).message}); skipping the sha256 check`);
  }
  const file = positional[0] ? userPath(positional[0]) : trackedGlb(hitboxes);
  const report = await validateFile(file, { hitboxes, file: toRepo(file) });
  console.log(flags.has("--json") ? JSON.stringify(report, null, 2) : formatReport(report));
  return report.ok ? 0 : 1;
});
