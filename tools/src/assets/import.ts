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
 */
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { bakeFile, formatHitboxes, writeHitboxes } from "./bake";
import { EXPORT_SCRIPT, HITBOXES_JSON, PLACEHOLDER_GLB, PUBLIC_DIR, fromRepo, toRepo, type HitboxesFile } from "./gltf";
import { cfLines, findBlender, parseReport, runBlender } from "../blender/run";
import { checkHitboxesForMoves, formatReport, validateFile, type ValidateReport } from "./validate";

export type ImportStage = "setup" | "export" | "validate" | "bake" | "done";

export interface ImportOptions {
  /** Absolute path of the .blend. */
  blend: string;
  /** Absolute path of the glb to write. */
  out: string;
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

/** Refuse inputs that would break the pipeline before spending a Blender run on them. */
function setupProblems(opts: ImportOptions, hitboxesPath: string): string[] {
  const problems: string[] = [];
  if (!opts.blend.toLowerCase().endsWith(".blend")) problems.push(`--blend ${opts.blend} is not a .blend file`);
  else if (!existsSync(opts.blend)) problems.push(`--blend ${opts.blend} does not exist`);
  if (!opts.out.toLowerCase().endsWith(".glb")) problems.push(`--out ${opts.out} must end in .glb`);
  if (samePath(opts.out, fromRepo(PLACEHOLDER_GLB))) {
    problems.push(`--out must not be ${PLACEHOLDER_GLB}: pnpm assets:placeholder owns it (the hero goes to its own file)`);
  }
  // The game fetches the glb hitboxes.json names, so it must be a static file of the web app.
  const rel = toRepo(opts.out);
  if (samePath(hitboxesPath, fromRepo(HITBOXES_JSON)) && !rel.startsWith(`${PUBLIC_DIR}/`)) {
    problems.push(`--out must be inside ${PUBLIC_DIR}/ so the game can load it (hitboxes.json.source.file decides which glb loads)`);
  }
  return problems;
}

export async function importChicken(opts: ImportOptions): Promise<ImportResult> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const hitboxesPath = opts.hitboxes ?? fromRepo(HITBOXES_JSON);
  const base = { problems: [] as string[], fixes: [] as string[], notes: [] as string[], blenderOutput: "" };
  log(`assets:import ${toRepo(opts.blend)} -> ${toRepo(opts.out)}${opts.retime ? " (--retime)" : ""}`);

  const setup = setupProblems(opts, hitboxesPath);
  if (setup.length) {
    log("setup FAILED:");
    for (const p of setup) log(`  - ${p}`);
    return { ...base, ok: false, stage: "setup", problems: setup };
  }

  // Export to a staging file and move it into place only after it validates:
  // re-importing over the glb hitboxes.json tracks must never leave the game
  // loading a new mesh with the old hitboxes.
  const staged = join(dirname(opts.out), `.${basename(opts.out, extname(opts.out))}.import-${process.pid}.glb`);
  try {
    return await stages(opts, staged, hitboxesPath, base, log);
  } finally {
    rmSync(staged, { force: true });
  }
}

async function stages(
  opts: ImportOptions,
  staged: string,
  hitboxesPath: string,
  base: Pick<ImportResult, "problems" | "fixes" | "notes" | "blenderOutput">,
  log: (line: string) => void,
): Promise<ImportResult> {
  // 1. export
  const blender = opts.blender ?? findBlender();
  log(`[1/3] export: ${blender} running ${EXPORT_SCRIPT}`);
  const run = runBlender(fromRepo(EXPORT_SCRIPT), ["--out", staged, ...(opts.retime ? ["--retime"] : [])], {
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
  const report = await validateFile(staged, { hitboxes: null, file: toRepo(opts.out) });
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
    baked = await bakeFile(staged);
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
  renameSync(staged, opts.out);
  writeHitboxes(text, hitboxesPath);
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
