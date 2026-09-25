/**
 * The hero import: Sammy's .blend -> glb -> validate -> hitboxes.json, one
 * stage at a time, stopping at the first that fails with what to fix.
 *
 *   1. export   headless Blender opens the .blend and runs
 *               art/blender/export_chicken.py (cf_common.export_chicken with
 *               the contract): UI habits with one right answer are fixed in
 *               memory (CF_FIX), everything else is reported at once (CF_ERROR)
 *   2. validate the glb against the contract, moves.json and the budgets
 *   3. bake     packages/sim/data/hitboxes.json from the new glb; its
 *               source.file/sha256 then point at it, which is what makes the
 *               game load it (createFightEngine chickenModelUrl)
 *
 * A dry run (--hitboxes somewhere else) never touches what the game loads: its
 * glb defaults to art/blender/out/<name>.glb, and it may not overwrite the glb
 * hitboxes.json names.
 *
 * Both outputs are staged complete in a per-run directory (under the
 * gitignored art/blender/out/ when the target is in the repo) and moved into
 * place back to back at the very end; Ctrl-C or SIGTERM removes the staging.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { bakeFile, formatHitboxes } from "./bake";
import { EXPORT_SCRIPT, HERO_GLB, HITBOXES_JSON, PLACEHOLDER_GLB, PUBLIC_DIR, SCRATCH_DIR, fromRepo, readHitboxes, toRepo, trackedGlb, type HitboxesFile } from "./gltf";
import { cfLines, findBlender, parseReport, runBlender } from "../blender/run";
import { checkHitboxesForMoves, formatReport, validateFile, type ValidateReport } from "./validate";

export type ImportStage = "setup" | "export" | "validate" | "bake" | "done";

export interface ImportOptions {
  /** Absolute path of the .blend. */
  blend: string;
  /** Absolute path of the glb to write (default: defaultImportOut). */
  out?: string;
  /** Rescale a scene authored at another frame rate instead of failing. */
  retime?: boolean;
  /** Where to write the bake (default packages/sim/data/hitboxes.json, which decides the glb the game loads). */
  hitboxes?: string;
  blender?: string;
  /** Output lines (default console.log). */
  log?: (line: string) => void;
}

export interface ImportResult {
  ok: boolean;
  /** The stage that failed, or "done". */
  stage: ImportStage;
  /** What to fix: CF_ERROR lines from the export, or validate/bake errors. */
  problems: string[];
  /** What the export fixed by itself (CF_FIX lines). */
  fixes: string[];
  notes: string[];
  /** Raw Blender output, for tests and debugging. */
  blenderOutput: string;
  report?: ValidateReport;
  hitboxes?: HitboxesFile;
  /** True when the bake changed the hitbox tables (rulesHash), so the goldens need re-blessing. */
  hitboxesChanged?: boolean;
}

const samePath = (a: string, b: string) => resolve(a) === resolve(b);
const isRealHitboxes = (path: string) => samePath(path, fromRepo(HITBOXES_JSON));

/**
 * The glb an import writes when --out is not given: the hero file for a real
 * import, art/blender/out/<blend name>.glb for a dry run (--hitboxes elsewhere),
 * so a dry run never replaces the glb the game loads.
 */
export function defaultImportOut(blend: string, hitboxesPath: string = fromRepo(HITBOXES_JSON)): string {
  return isRealHitboxes(hitboxesPath) ? fromRepo(HERO_GLB) : join(fromRepo(SCRATCH_DIR), `${basename(blend, extname(blend))}.glb`);
}

/**
 * Where an import stages the file it will move to `target`: a per-run
 * directory on the target's filesystem (so the final rename is atomic). Under
 * the gitignored scratch dir for targets inside the repo, so an interrupted
 * run never leaves files `git add -A` would pick up; next to the target otherwise.
 */
export function stagingDir(target: string, pid: number = process.pid): string {
  const inRepo = !isAbsolute(toRepo(target));
  return join(inRepo ? fromRepo(SCRATCH_DIR) : dirname(target), `.import-${pid}`);
}

/** The glb packages/sim/data/hitboxes.json names (the one the game loads), or null if it can't be read. */
function loadedGlb(): string | null {
  try {
    return trackedGlb(readHitboxes());
  } catch {
    return null;
  }
}

/**
 * Inputs that would break the pipeline, refused before spending a Blender run
 * on them. `loaded` is the glb the game loads now (read from hitboxes.json).
 */
export function setupProblems(opts: ImportOptions & { out: string }, hitboxesPath: string, loaded: string | null = loadedGlb()): string[] {
  const problems: string[] = [];
  if (!opts.blend.toLowerCase().endsWith(".blend")) problems.push(`--blend ${opts.blend} is not a .blend file`);
  else if (!existsSync(opts.blend)) problems.push(`--blend ${opts.blend} does not exist`);
  if (!opts.out.toLowerCase().endsWith(".glb")) problems.push(`--out ${opts.out} must end in .glb`);
  if (samePath(opts.out, fromRepo(PLACEHOLDER_GLB))) {
    problems.push(`--out must not be ${PLACEHOLDER_GLB}: pnpm assets:placeholder owns it (the hero goes to its own file)`);
  } else if (!isRealHitboxes(hitboxesPath) && loaded && samePath(opts.out, loaded)) {
    // A dry run leaves hitboxes.json alone, so replacing this glb would pair a new mesh with the old hitboxes.
    problems.push(
      `--out must not be ${toRepo(loaded)} in a dry run (--hitboxes ${toRepo(hitboxesPath)}): ${HITBOXES_JSON} names it, so the game loads it. ` +
        `Leave --out off (the glb goes to ${toRepo(defaultImportOut(opts.blend, hitboxesPath))}) or pick another file`,
    );
  }
  // The game fetches the glb hitboxes.json names, so it must be a static file of the web app.
  const rel = toRepo(opts.out);
  if (isRealHitboxes(hitboxesPath) && !rel.startsWith(`${PUBLIC_DIR}/`)) {
    problems.push(`--out must be inside ${PUBLIC_DIR}/ so the game can load it (hitboxes.json.source.file decides which glb loads)`);
  }
  return problems;
}

/** Where the two outputs are written before they are moved into place. */
interface Staged {
  glb: string;
  hitboxes: string;
}

export async function importChicken(options: ImportOptions): Promise<ImportResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const hitboxesPath = options.hitboxes ?? fromRepo(HITBOXES_JSON);
  const opts = { ...options, out: options.out ?? defaultImportOut(options.blend, hitboxesPath) };
  const base = { problems: [] as string[], fixes: [] as string[], notes: [] as string[], blenderOutput: "" };
  log(`assets:import ${toRepo(opts.blend)} -> ${toRepo(opts.out)}${opts.retime ? " (--retime)" : ""}`);

  const setup = setupProblems(opts, hitboxesPath);
  if (setup.length) {
    log("setup FAILED:");
    for (const p of setup) log(`  - ${p}`);
    return { ...base, ok: false, stage: "setup", problems: setup };
  }

  // Export and bake into staging, and move both into place only after
  // everything passed: re-importing over the glb hitboxes.json tracks must
  // never leave the game loading a new mesh with the old hitboxes.
  const glbDir = stagingDir(opts.out);
  const hitboxesDir = stagingDir(hitboxesPath);
  const dirs = [...new Set([glbDir, hitboxesDir])];
  const staged: Staged = { glb: join(glbDir, basename(opts.out)), hitboxes: join(hitboxesDir, `bake-${basename(hitboxesPath)}`) };
  const cleanup = () => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  };
  // Node exits on SIGINT/SIGTERM without running `finally`; clean up first.
  const onSignal = (signal: NodeJS.Signals) => {
    cleanup();
    log(`assets:import interrupted (${signal}); nothing was moved into place`);
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    for (const dir of dirs) mkdirSync(dir, { recursive: true });
    return await stages(opts, staged, hitboxesPath, base, log);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    cleanup();
  }
}

async function stages(
  opts: ImportOptions & { out: string },
  staged: Staged,
  hitboxesPath: string,
  base: Pick<ImportResult, "problems" | "fixes" | "notes" | "blenderOutput">,
  log: (line: string) => void,
): Promise<ImportResult> {
  // 1. export
  const blender = opts.blender ?? findBlender();
  log(`[1/3] export: ${blender} running ${EXPORT_SCRIPT}`);
  const run = runBlender(fromRepo(EXPORT_SCRIPT), ["--out", staged.glb, ...(opts.retime ? ["--retime"] : [])], {
    blender,
    blend: opts.blend,
    capture: true,
    captureStderr: true,
    echo: false,
  });
  const output = `${run.stdout}\n${run.stderr}`;
  const fixes = cfLines(run.stdout, "FIX");
  const notes = [...cfLines(run.stdout, "NOTE"), ...cfLines(run.stdout, "WARNING")];
  const errors = cfLines(run.stderr, "ERROR");
  for (const f of fixes) log(`  fixed: ${f}`);
  for (const n of notes) log(`  note:  ${n}`);
  const exported = parseReport(run.stdout);
  const withRun = { ...base, fixes, notes, blenderOutput: output };
  if (run.status !== 0 || !exported) {
    const problems = errors.length ? errors : [`Blender exited with ${run.status} and no CF_ERROR; its output ends:\n${output.trim().split("\n").slice(-30).join("\n")}`];
    log(`[1/3] export FAILED (${problems.length} problem${problems.length === 1 ? "" : "s"}): fix ${problems.length === 1 ? "it" : "them"} in Blender, save, and run the import again`);
    problems.forEach((p, i) => log(`  ${i + 1}. ${p}`));
    return { ...withRun, ok: false, stage: "export", problems };
  }
  log(`  exported ${exported["tris"]} tris, ${exported["joints"]} joints, ${exported["clips"]} clips, ${Math.round(Number(exported["bytes"]) / 1024)} KB`);

  // 2. validate (hitboxes.json is re-baked next, so its sha256 is not checked here)
  log("[2/3] validate");
  const report = await validateFile(staged.glb, { hitboxes: null, file: toRepo(opts.out) });
  log(formatReport(report).replace(/^/gm, "  "));
  if (!report.ok) {
    const problems = report.issues.filter((i) => i.severity === "error").map((i) => `[${i.code}] ${i.message}`);
    log("[2/3] validate FAILED: the export ran, but the glb breaks the rules above; fix them in Blender and run the import again");
    return { ...withRun, ok: false, stage: "validate", problems, report };
  }

  // 3. bake (from the bytes that are about to be moved into place, recorded under their final path)
  log(`[3/3] bake -> ${toRepo(hitboxesPath)}`);
  const before = existsSync(hitboxesPath) ? readFileSync(hitboxesPath, "utf8") : "";
  let baked: { hitboxes: HitboxesFile; text: string };
  try {
    baked = await bakeFile(staged.glb);
  } catch (e) {
    const problems = [(e as Error).message];
    log(`[3/3] bake FAILED: ${problems[0]}`);
    return { ...withRun, ok: false, stage: "bake", problems, report };
  }
  const hitboxes: HitboxesFile = { ...baked.hitboxes, source: { ...baked.hitboxes.source, file: toRepo(opts.out) } };
  const missing = checkHitboxesForMoves(hitboxes);
  if (missing.length) {
    const problems = missing.map((i) => i.message);
    log("[3/3] bake FAILED:");
    for (const p of problems) log(`  - ${p}`);
    return { ...withRun, ok: false, stage: "bake", problems, report, hitboxes };
  }
  const text = formatHitboxes(hitboxes);
  // Every write that can fail (a full disk, a missing directory) happens before
  // either file moves; then the two renames run back to back. The glb goes
  // first, so hitboxes.json, which decides the glb the game loads, flips last.
  writeFileSync(staged.hitboxes, text);
  mkdirSync(dirname(opts.out), { recursive: true });
  mkdirSync(dirname(hitboxesPath), { recursive: true });
  renameSync(staged.glb, opts.out);
  renameSync(staged.hitboxes, hitboxesPath);
  // rulesHash covers the clip tables, not source.file/sha256: only a change there changes gameplay.
  const changed = before !== text;
  const gameplay = changed && JSON.stringify(parseClips(before)) !== JSON.stringify(hitboxes.clips);
  log(`  baked ${Object.keys(hitboxes.clips).length} clips from ${hitboxes.source.file} (sha256 ${hitboxes.source.sha256.slice(0, 12)})${changed ? "" : "; unchanged"}`);

  log("");
  if (!samePath(hitboxesPath, fromRepo(HITBOXES_JSON))) {
    log(`done. The bake went to ${toRepo(hitboxesPath)}, so the game still loads what packages/sim/data/hitboxes.json names.`);
  } else if (!changed) {
    log("done. hitboxes.json is unchanged, so rulesHash and the golden replays are too.");
  } else if (!gameplay) {
    log(`done. The game now loads ${toRepo(opts.out)}; its hitbox tables equal the old ones, so rulesHash and the golden replays don't change.`);
    log(`  commit ${toRepo(opts.out)} and ${HITBOXES_JSON} together`);
  } else {
    log("done. Next steps (a new rig changes the hitboxes, so it changes gameplay):");
    log("  1. pnpm replay:golden --bless     rulesHash covers the baked hitboxes, so every golden replay changes");
    log("  2. pnpm test && pnpm assets:validate && pnpm assets:bake --check");
    log("  3. pnpm dev, then http://localhost:3000/play?debug=1 (H toggles the hitbox overlay) to see it fight");
    log(`  4. commit ${toRepo(opts.out)}, ${HITBOXES_JSON} and the re-blessed goldens together, and say why`);
  }
  return { ...withRun, ok: true, stage: "done", report, hitboxes, hitboxesChanged: gameplay };
}

function parseClips(text: string): unknown {
  try {
    return (JSON.parse(text) as HitboxesFile).clips;
  } catch {
    return null;
  }
}
