/** pnpm assets:inspect <glb>: print a glb's node tree, skin, materials and clips. */
import { readFileSync } from "node:fs";
import { toRepo, userPath } from "../assets/gltf";
import { inspectGlb } from "../assets/inspect";
import { cli, parseArgs } from "./main";

cli(async (argv) => {
  const { positional } = parseArgs(argv, [], "usage: pnpm assets:inspect <glb>");
  if (positional.length !== 1) throw new Error("usage: pnpm assets:inspect <glb>");
  const file = userPath(positional[0]!);
  console.log(await inspectGlb(new Uint8Array(readFileSync(file)), toRepo(file)));
  return 0;
});
