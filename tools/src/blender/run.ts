/**
 * Run a Python script in headless Blender and pass its exit code through.
 *
 * `--factory-startup` ignores the user's prefs and add-ons so every machine
 * builds the same file, and `--python-exit-code 1` is mandatory: without it a
 * Python exception still exits 0.
 */
import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

export const MAC_BLENDER = "/Applications/Blender.app/Contents/MacOS/Blender";

export class BlenderNotFoundError extends Error {
  override name = "BlenderNotFoundError";
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** $BLENDER, then the macOS app bundle, then `blender` on PATH. */
export function findBlender(env: NodeJS.ProcessEnv = process.env, macPath = MAC_BLENDER): string {
  if (env.BLENDER) {
    if (executable(env.BLENDER)) return env.BLENDER;
    throw new BlenderNotFoundError(`BLENDER=${env.BLENDER} is not an executable file`);
  }
  if (executable(macPath)) return macPath;
  const names = process.platform === "win32" ? ["blender.exe", "blender"] : ["blender"];
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const name of names) if (executable(join(dir, name))) return join(dir, name);
  }
  throw new BlenderNotFoundError(
    `Blender not found (looked at $BLENDER, ${macPath} and PATH). Install Blender 5.2 ` +
      "(https://www.blender.org/download/) or set BLENDER=/path/to/blender. CI never needs it: the glb is committed.",
  );
}

export function blenderArgs(script: string, args: readonly string[] = []): string[] {
  return ["-b", "--factory-startup", "--python-exit-code", "1", "--python", script, "--", ...args];
}

export interface BlenderRun {
  status: number;
  /** Captured stdout when `capture` is set (it is also echoed), else "". */
  stdout: string;
}

/**
 * Run `script` with `args` after `--`. Exit status 1 if Blender died from a
 * signal. `cwd` is where relative paths in `args` resolve.
 */
export function runBlender(
  script: string,
  args: readonly string[] = [],
  opts: { blender?: string; capture?: boolean; cwd?: string } = {},
): BlenderRun {
  const blender = opts.blender ?? findBlender();
  const res = spawnSync(blender, blenderArgs(script, args), {
    cwd: opts.cwd,
    stdio: ["ignore", opts.capture ? "pipe" : "inherit", "inherit"],
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) throw new Error(`could not run ${blender}: ${res.error.message}`);
  const stdout = opts.capture ? (res.stdout ?? "") : "";
  if (stdout) process.stdout.write(stdout);
  if (res.signal) console.error(`blender was killed by ${res.signal}`);
  return { status: res.status ?? 1, stdout };
}

/** The `CF_REPORT {json}` line cf_common.export_chicken() prints, if any. */
export function parseReport(stdout: string): Record<string, unknown> | null {
  const line = stdout.split("\n").find((l) => l.startsWith("CF_REPORT "));
  return line ? (JSON.parse(line.slice("CF_REPORT ".length)) as Record<string, unknown>) : null;
}
