import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path of the repo root, so tools work from any cwd. */
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const repoPath = (...p: string[]): string => join(REPO_ROOT, ...p);
