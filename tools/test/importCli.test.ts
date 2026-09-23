/**
 * The Blender-free parts of `pnpm assets:import`: argument parsing, the
 * Blender command line, the inputs refused before Blender runs, the exit codes,
 * the staging and dry-run rules (through a stand-in Blender that copies the
 * placeholder glb), and the UI preset staying in sync with EXPORT_KWARGS. The
 * Blender round trips are in heroImport.test.ts (local only).
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { HERO_GLB, HITBOXES_JSON, PLACEHOLDER_GLB, SCRATCH_DIR, fromRepo, readHitboxes, type HitboxesFile } from "../src/assets/gltf";
import { defaultImportOut, importChicken, setupProblems, stagingDir } from "../src/assets/import";
import { blenderArgs, cfLines } from "../src/blender/run";
import { parseArgs } from "../src/cli/main";
import { repoPath } from "../src/root";

const tmp = mkdtempSync(join(tmpdir(), "cf-import-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const quiet = () => {};

describe("cli parseArgs", () => {
  it("reads flags, --opt value, --opt=value and positionals", () => {
    const r = parseArgs(["a.glb", "--out", "x.glb", "--retime", "--hitboxes=h.json", "--arena=z.glb"], ["--retime", "--arena"], "usage", ["--out", "--hitboxes"]);
    expect([...r.flags].sort()).toEqual(["--arena", "--retime"]);
    expect(Object.fromEntries(r.values)).toEqual({ "--out": "x.glb", "--hitboxes": "h.json", "--arena": "z.glb" });
    expect(r.positional).toEqual(["a.glb"]);
  });

  it("rejects unknown options and missing values", () => {
    expect(() => parseArgs(["--nope"], [], "usage")).toThrow("unknown option --nope");
    expect(() => parseArgs(["--out"], [], "usage", ["--out"])).toThrow("--out needs a value");
    expect(() => parseArgs(["--out", "--retime"], ["--retime"], "usage", ["--out"])).toThrow("--out needs a value");
  });
});

describe("blender runner", () => {
  it("opens the .blend after --factory-startup and before the script", () => {
    expect(blenderArgs("s.py", ["--out", "o.glb"], "hero.blend")).toEqual([
      "-b",
      "--factory-startup",
      "hero.blend",
      "--python-exit-code",
      "1",
      "--python",
      "s.py",
      "--",
      "--out",
      "o.glb",
    ]);
    expect(blenderArgs("s.py")).toEqual(["-b", "--factory-startup", "--python-exit-code", "1", "--python", "s.py", "--"]);
  });

  it("picks CF_ lines out of Blender's output", () => {
    const out = "Draco chatter\nCF_FIX: one\nCF_NOTE: n\nCF_FIX: two\nCF_ERROR: bad\n";
    expect(cfLines(out, "FIX")).toEqual(["one", "two"]);
    expect(cfLines(out, "ERROR")).toEqual(["bad"]);
  });
});

describe("importChicken refuses bad inputs before running Blender", () => {
  const blend = join(tmp, "hero.blend");
  writeFileSync(blend, "not really a blend");

  it("a missing .blend", async () => {
    const r = await importChicken({ blend: join(tmp, "nope.blend"), out: fromRepo("apps/web/public/models/chicken.glb"), log: quiet });
    expect(r).toMatchObject({ ok: false, stage: "setup" });
    expect(r.problems[0]).toMatch(/nope\.blend does not exist$/);
  });

  it("overwriting the placeholder", async () => {
    const r = await importChicken({ blend, out: fromRepo(PLACEHOLDER_GLB), log: quiet });
    expect(r.problems).toEqual([`--out must not be ${PLACEHOLDER_GLB}: pnpm assets:placeholder owns it (the hero goes to its own file)`]);
  });

  it("a glb the game can't serve, when the bake would go to the real hitboxes.json", async () => {
    const r = await importChicken({ blend, out: join(tmp, "chicken.glb"), log: quiet });
    expect(r.problems).toEqual(["--out must be inside apps/web/public/ so the game can load it (hitboxes.json.source.file decides which glb loads)"]);
  });

  it("a dry run (--hitboxes elsewhere) over the glb hitboxes.json names", () => {
    const hitboxes = join(tmp, "dry.json");
    const hero = fromRepo(HERO_GLB);
    // After a real import hitboxes.json names chicken.glb: a dry run must not replace it under the game.
    expect(setupProblems({ blend, out: hero }, hitboxes, hero)).toEqual([
      `--out must not be ${HERO_GLB} in a dry run (--hitboxes ${hitboxes}): ${HITBOXES_JSON} names it, so the game loads it. ` +
        `Leave --out off (the glb goes to ${SCRATCH_DIR}/hero.glb) or pick another file`,
    ]);
    // A real import may replace it (it re-bakes hitboxes.json with it), and a dry run may write any other glb.
    expect(setupProblems({ blend, out: hero }, fromRepo(HITBOXES_JSON), hero)).toEqual([]);
    expect(setupProblems({ blend, out: join(tmp, "other.glb") }, hitboxes, hero)).toEqual([]);
  });
});

describe("assets:import defaults and staging", () => {
  it("a dry run writes its glb to art/blender/out/<blend name>.glb unless --out says otherwise", () => {
    expect(defaultImportOut("/art/hero.blend")).toBe(fromRepo(HERO_GLB));
    expect(defaultImportOut("/art/hero.blend", fromRepo(HITBOXES_JSON))).toBe(fromRepo(HERO_GLB));
    expect(defaultImportOut("/art/hero.blend", join(tmp, "dry.json"))).toBe(fromRepo(`${SCRATCH_DIR}/hero.glb`));
  });

  it("stages repo files under the gitignored scratch dir, other files next to their target", () => {
    expect(stagingDir(fromRepo(HERO_GLB), 42)).toBe(fromRepo(`${SCRATCH_DIR}/.import-42`));
    expect(stagingDir(fromRepo(HITBOXES_JSON), 42)).toBe(fromRepo(`${SCRATCH_DIR}/.import-42`));
    expect(stagingDir(join(tmp, "x", "hero.glb"), 42)).toBe(join(tmp, "x", ".import-42"));
  });
});

/**
 * A stand-in for Blender: it copies the committed placeholder glb to the
 * --out it is given (recording that path), prints the CF_REPORT line, and with
 * `interrupt` first sends SIGINT to the process that ran it, as Ctrl-C would.
 */
function fakeBlender(dir: string, opts: { interrupt?: boolean } = {}): { path: string; outLog: string } {
  const path = join(dir, opts.interrupt ? "blender-interrupt" : "blender");
  const outLog = `${path}.out`;
  const script = [
    "#!/bin/sh",
    'prev=""; out=""',
    'for a in "$@"; do [ "$prev" = "--out" ] && out="$a"; prev="$a"; done',
    `printf '%s' "$out" > '${outLog}'`,
    `cp '${fromRepo(PLACEHOLDER_GLB)}' "$out"`,
    opts.interrupt ? 'kill -INT "$PPID"' : "",
    `echo 'CF_REPORT {"tris": 1, "joints": 16, "clips": 21, "bytes": 1024}'`,
    "",
  ].join("\n");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return { path, outLog };
}

/** Staging directories or Blender temp files left in `dir`. */
const importLeftovers = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith(".import-") || f.endsWith(".tmp.glb")) : []);

describe.skipIf(process.platform === "win32")("assets:import end to end with a stand-in Blender", () => {
  const blend = join(tmp, "stand_in.blend");
  writeFileSync(blend, "");
  const committed = readHitboxes();

  it("stages next to an out-of-repo target, moves the glb and the bake into place, and cleans up", async () => {
    const outDir = join(tmp, "e2e");
    mkdirSync(outDir, { recursive: true });
    const blender = fakeBlender(tmp);
    const out = join(outDir, "hero.glb");
    const hitboxes = join(outDir, "hero.json");
    const r = await importChicken({ blend, out, hitboxes, blender: blender.path, log: quiet });
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    // Blender wrote into this run's staging directory, never over the target.
    expect(readFileSync(blender.outLog, "utf8")).toBe(join(outDir, `.import-${process.pid}`, "hero.glb"));
    expect(readFileSync(out).equals(readFileSync(fromRepo(PLACEHOLDER_GLB)))).toBe(true);
    const baked = JSON.parse(readFileSync(hitboxes, "utf8")) as HitboxesFile;
    expect(baked.source).toEqual({ file: out, sha256: committed.source.sha256 });
    expect(baked.clips).toEqual(committed.clips);
    expect(importLeftovers(outDir)).toEqual([]);
  });

  it("a dry run without --out writes art/blender/out/<blend name>.glb and leaves the real bake alone", async () => {
    const before = readFileSync(fromRepo(HITBOXES_JSON), "utf8");
    const name = `cf_dry_run_${process.pid}`;
    const dryBlend = join(tmp, `${name}.blend`);
    writeFileSync(dryBlend, "");
    const hitboxes = join(tmp, `${name}.json`);
    const out = fromRepo(`${SCRATCH_DIR}/${name}.glb`);
    const blender = fakeBlender(tmp);
    try {
      const r = await importChicken({ blend: dryBlend, hitboxes, blender: blender.path, log: quiet });
      expect(r.ok).toBe(true);
      expect(readFileSync(blender.outLog, "utf8")).toBe(fromRepo(`${SCRATCH_DIR}/.import-${process.pid}/${name}.glb`));
      expect(existsSync(out)).toBe(true);
      expect((JSON.parse(readFileSync(hitboxes, "utf8")) as HitboxesFile).source.file).toBe(`${SCRATCH_DIR}/${name}.glb`);
      expect(readFileSync(fromRepo(HITBOXES_JSON), "utf8")).toBe(before);
      expect(importLeftovers(fromRepo(SCRATCH_DIR))).toEqual([]);
    } finally {
      rmSync(out, { force: true });
    }
  });

  it("Ctrl-C during the import removes the staging and moves nothing into place", () => {
    const outDir = join(tmp, "interrupted");
    mkdirSync(outDir, { recursive: true });
    const blender = fakeBlender(tmp, { interrupt: true });
    const out = join(outDir, "hero.glb");
    const hitboxes = join(outDir, "hero.json");
    const tsx = repoPath("tools", "node_modules", ".bin", "tsx");
    const res = spawnSync(tsx, ["src/cli/import.ts", "--blend", blend, "--out", out, "--hitboxes", hitboxes], {
      cwd: repoPath("tools"),
      encoding: "utf8",
      env: { ...process.env, BLENDER: blender.path, INIT_CWD: repoPath() },
    });
    expect(res.status, `${res.stdout}\n${res.stderr}`).toBe(130);
    expect(res.stdout).toContain("assets:import interrupted (SIGINT); nothing was moved into place");
    // Blender did write the staged glb (then the signal came); it is gone with its staging directory.
    const staged = readFileSync(blender.outLog, "utf8");
    expect(dirname(dirname(staged))).toBe(outDir);
    expect(basename(dirname(staged))).toMatch(/^\.import-\d+$/);
    expect(existsSync(out)).toBe(false);
    expect(existsSync(hitboxes)).toBe(false);
    expect(importLeftovers(outDir)).toEqual([]);
  });
});

describe("pnpm assets:import (the CLI)", () => {
  const tsx = repoPath("tools", "node_modules", ".bin", "tsx");
  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(tsx, ["src/cli/import.ts", ...args], { cwd: repoPath("tools"), encoding: "utf8", env: { ...process.env, INIT_CWD: repoPath(), ...env } });

  it("prints usage and exits 2 without --blend", () => {
    const r = run([]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("usage: pnpm assets:import --blend <file.blend>");
  });

  it("a dry run's glb defaults to art/blender/out/<blend name>.glb", () => {
    const r = run(["--blend", join(tmp, "nope.blend"), "--hitboxes", join(tmp, "dry.json")]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`-> ${SCRATCH_DIR}/nope.glb`);
  });

  it("every root assets:* wrapper that takes paths forwards the user's directory as CF_CWD", () => {
    const scripts = (JSON.parse(readFileSync(repoPath("package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
    for (const name of ["assets:validate", "assets:bake", "assets:inspect", "assets:import"]) {
      expect(scripts[name], name).toBe(`CF_CWD="$INIT_CWD" pnpm -s --filter @cockfight/tools run ${name}`);
    }
  });

  const hasPnpm = spawnSync("pnpm", ["--version"]).status === 0;
  it.skipIf(!hasPnpm)("the root wrapper resolves --blend against where the user ran it, not the repo root", () => {
    // As in validate.test.ts: no ::group:: annotations from pnpm on GitHub Actions.
    const env = { ...process.env, GITHUB_ACTIONS: "", CI: "" };
    const r = spawnSync("pnpm", ["-s", "assets:import", "--blend", "nothere.blend"], { cwd: repoPath("docs"), encoding: "utf8", env });
    expect(r.status, r.stderr).toBe(1);
    expect(r.stdout).toContain(`--blend ${repoPath("docs", "nothere.blend")} does not exist`);
  });

  it("exits 3 with install instructions when Blender is missing, leaving hitboxes.json alone", () => {
    const before = readFileSync(fromRepo(HITBOXES_JSON), "utf8");
    const blend = join(tmp, "x.blend");
    writeFileSync(blend, "");
    const r = run(["--blend", blend], { BLENDER: join(tmp, "no-blender") });
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("is not an executable file");
    expect(readFileSync(fromRepo(HITBOXES_JSON), "utf8")).toBe(before);
  });
});

describe("the UI preset", () => {
  /** `key=value` pairs of cf_common.py's EXPORT_KWARGS, values as Python source. */
  function exportKwargs(): Map<string, string> {
    const src = readFileSync(repoPath("art", "blender", "cf_common.py"), "utf8");
    const body = /EXPORT_KWARGS = dict\(\n([\s\S]*?)\n\)/.exec(src)![1]!;
    const out = new Map<string, string>();
    for (const line of body.split("\n")) {
      const m = /^\s+(\w+)=(.+?),(\s*#.*)?$/.exec(line);
      if (m) out.set(m[1]!, m[2]!.replace(/'/g, '"'));
    }
    return out;
  }

  it("sets EXPORT_KWARGS (minus check_existing, which presets don't store) and every other setting, each once", () => {
    // Generated by art/blender/make_preset.py; heroImport.test.ts (with Blender) checks it is complete for the
    // exporter and exports the scripted export's bytes. This is the part CI can check without Blender.
    const src = readFileSync(repoPath("art", "blender", "presets", "cockfight_glb.py"), "utf8");
    expect(src).toContain("GENERATED by art/blender/make_preset.py");
    const preset = new Map<string, string>();
    for (const m of src.matchAll(/^op\.(\w+) = (.+)$/gm)) {
      expect(preset.has(m[1]!), `${m[1]} set twice`).toBe(false);
      preset.set(m[1]!, m[2]!.replace(/'/g, '"'));
    }
    const kwargs = exportKwargs();
    kwargs.delete("check_existing");
    expect(kwargs.size).toBeGreaterThan(30);
    for (const [key, value] of kwargs) expect(preset.get(key), key).toBe(value);
    // Applying a preset sets only what it lists, so it lists everything (Blender 5.2's exporter stores 107
    // settings in presets) except the file the dialog is about to write.
    expect(preset.size).toBeGreaterThan(100);
    for (const key of ["filepath", "check_existing", "filter_glob"]) expect(preset.has(key), key).toBe(false);
  });
});
