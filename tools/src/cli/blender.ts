/**
 * pnpm --filter @cockfight/tools run blender <script.py> [script args...]
 * Runs a script in headless Blender (see blender/run.ts) and exits with its code.
 * Blender runs in the directory pnpm was invoked from, so relative paths in
 * the script's arguments mean what the user typed.
 */
import { userPath } from "../assets/gltf";
import { runBlender } from "../blender/run";
import { cli } from "./main";

cli((argv) => {
  const [script, ...args] = argv;
  if (!script || script.startsWith("-")) throw new Error("usage: blender <script.py> [script args...]");
  return runBlender(userPath(script), args, { cwd: userPath(".") }).status;
});
