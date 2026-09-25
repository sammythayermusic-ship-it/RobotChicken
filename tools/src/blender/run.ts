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

/**
 * Blender's command line. A .blend to open goes after `--factory-startup` (so
 * the user's startup file and add-ons stay out of it) and before `--python`
 * (Blender acts on its arguments in order, so the file is loaded first).
 */
export function blenderArgs(script: string, args: readonly string[] = [], blend?: string): string[] {
  return ["-b", "--factory-startup", ...(blend ? [blend] : []), "--python-exit-code", "1", "--python", script, "--", ...args];
}

export interface BlenderRun {
  status: number;
  /** Captured stdout when `capture` is set (it is also echoed), else "". */
  stdout: string;
  /** Captured stderr when `captureStderr` is set (it is also echoed), else "". */
  stderr: string;
}

export interface BlenderOptions {
  blender?: string;
  /** Capture (and still echo) stdout. */
  capture?: boolean;
  /** Capture (and still echo) stderr, where the CF_ERROR lines go. */
  captureStderr?: boolean;
  /** Echo captured output (default true); tests turn it off. */
  echo?: boolean;
  /** Where relative paths in `args` resolve. */
  cwd?: string;
  /** A .blend to open before the script runs. */
  blend?: string;
}

/** Run `script` with `args` after `--`. Exit status 1 if Blender died from a signal. */
export function runBlender(script: string, args: readonly string[] = [], opts: BlenderOptions = {}): BlenderRun {
  const blender = opts.blender ?? findBlender();
  const res = spawnSync(blender, blenderArgs(script, args, opts.blend), {
    cwd: opts.cwd,
    stdio: ["ignore", opts.capture ? "pipe" : "inherit", opts.captureStderr ? "pipe" : "inherit"],
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) throw new Error(`could not run ${blender}: ${res.error.message}`);
  const stdout = opts.capture ? (res.stdout ?? "") : "";
  const stderr = opts.captureStderr ? (res.stderr ?? "") : "";
  if (opts.echo !== false) {
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
  }
  if (res.signal) console.error(`blender was killed by ${res.signal}`);
  return { status: res.status ?? 1, stdout, stderr };
}

/** The `CF_<tag>: message` lines a run printed (CF_ERROR, CF_FIX, CF_NOTE), in order. */
export function cfLines(output: string, tag: "ERROR" | "FIX" | "NOTE" | "WARNING"): string[] {
  const prefix = `CF_${tag}: `;
  return output
    .split("\n")
    .filter((l) => l.startsWith(prefix))
    .map((l) => l.slice(prefix.length));
}

/** The `CF_REPORT {json}` line cf_common.export_chicken() prints, if any. */
export function parseReport(stdout: string): Record<string, unknown> | null {
  const line = stdout.split("\n").find((l) => l.startsWith("CF_REPORT "));
  return line ? (JSON.parse(line.slice("CF_REPORT ".length)) as Record<string, unknown>) : null;
}
