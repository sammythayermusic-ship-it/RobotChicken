/**
 * The Blender-free parts of `pnpm assets:import`: argument parsing, the
 * Blender command line, the inputs refused before Blender runs, the exit codes,
 * and the UI preset staying in sync with EXPORT_KWARGS. The Blender round trips
 * are in heroImport.test.ts (local only).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { HITBOXES_JSON, PLACEHOLDER_GLB, fromRepo } from "../src/assets/gltf";
import { importChicken } from "../src/assets/import";
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

  it("sets exactly EXPORT_KWARGS (minus check_existing, which presets don't store)", () => {
    const src = readFileSync(repoPath("art", "blender", "presets", "cockfight_glb.py"), "utf8");
    const preset = new Map<string, string>();
    for (const m of src.matchAll(/^op\.(\w+) = (.+)$/gm)) preset.set(m[1]!, m[2]!.replace(/'/g, '"'));
    const kwargs = exportKwargs();
    kwargs.delete("check_existing");
    expect(kwargs.size).toBeGreaterThan(30);
    expect(Object.fromEntries(preset)).toEqual(Object.fromEntries(kwargs));
  });
});
