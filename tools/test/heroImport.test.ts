/**
 * The hero import path end to end, through real headless Blender. LOCAL ONLY:
 * skipped when Blender is not installed (CI) or CF_SKIP_BLENDER is set.
 *
 * - A clean placeholder .blend round-trips through export_chicken.py to a glb
 *   whose baked clips equal the committed placeholder's (clips only: the
 *   source path, and on another Blender the sha256, differ).
 * - art/blender/make_messy_fixture.py builds the placeholder with UI-authored
 *   habits; the import must fix each one or report it with its exact hint.
 * - The UI preset is valid inside Blender and exports the same bytes.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HITBOXES_JSON, PLACEHOLDER_SCRIPT, fromRepo, readHitboxes, type HitboxesFile } from "../src/assets/gltf";
import { importChicken, type ImportResult } from "../src/assets/import";
import { findBlender, runBlender } from "../src/blender/run";
import { repoPath } from "../src/root";

const blender = (() => {
  if (process.env.CF_SKIP_BLENDER) return null;
  try {
    return findBlender();
  } catch {
    return null;
  }
})();

const FIXTURE_SCRIPT = "art/blender/make_messy_fixture.py";
const LONG = 120_000;

describe.skipIf(!blender)("hero import through Blender (local only)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "cf-hero-"));
  const committed = readHitboxes();
  const committedText = readFileSync(fromRepo(HITBOXES_JSON), "utf8");
  let placeholderBlend = "";

  function blenderRun(script: string, args: string[], blend?: string) {
    const r = runBlender(fromRepo(script), args, { blender: blender!, blend, capture: true, captureStderr: true, echo: false });
    expect(r.status, `${script} failed:\n${r.stderr}`).toBe(0);
    return r;
  }

  function fixture(name: string, habits: string): string {
    const out = join(tmp, `${name}.blend`);
    blenderRun(FIXTURE_SCRIPT, ["--out", out, "--habits", habits]);
    return out;
  }

  async function run(blend: string, retime = false): Promise<{ r: ImportResult; out: string; hitboxes: string; log: string }> {
    const stem = `${basename(blend, ".blend")}${retime ? "_retime" : ""}`;
    const out = join(tmp, `${stem}.glb`);
    const hitboxes = join(tmp, `${stem}.hitboxes.json`);
    const lines: string[] = [];
    const r = await importChicken({ blend, out, hitboxes, retime, blender: blender!, log: (l) => lines.push(l) });
    return { r, out, hitboxes, log: lines.join("\n") };
  }

  /** Largest difference (mu) between a bake and the committed placeholder's, clip by clip; Infinity if shapes differ. */
  function worstDiff(baked: HitboxesFile): number {
    let worst = 0;
    expect(Object.keys(baked.clips)).toEqual(Object.keys(committed.clips));
    for (const [name, want] of Object.entries(committed.clips)) {
      const got = baked.clips[name]!;
      if (got.n !== want.n) return Infinity;
      const pairs: [number[], number[] | undefined][] = [[want.hurt, got.hurt], ...Object.entries(want.hit).map(([k, v]): [number[], number[] | undefined] => [v, got.hit[k]])];
      for (const [a, b] of pairs) {
        if (!b || a.length !== b.length) return Infinity;
        a.forEach((v, i) => (worst = Math.max(worst, Math.abs(v - b[i]!))));
      }
    }
    return worst;
  }

  beforeAll(() => {
    placeholderBlend = join(tmp, "placeholder.blend");
    blenderRun(PLACEHOLDER_SCRIPT, ["--blend", placeholderBlend]);
  }, LONG);

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
    // Nothing here may touch the committed bake.
    expect(readFileSync(fromRepo(HITBOXES_JSON), "utf8")).toBe(committedText);
  });

  it(
    "a clean placeholder .blend round-trips to exactly the committed placeholder's clips",
    async () => {
      const { r, out, hitboxes } = await run(placeholderBlend);
      expect(r.problems).toEqual([]);
      expect(r.ok).toBe(true);
      expect(r.fixes).toEqual([]); // a scripted file has none of the UI habits
      const baked = JSON.parse(readFileSync(hitboxes, "utf8")) as HitboxesFile;
      expect(baked.clips).toEqual(committed.clips);
      expect(baked.source.file).toBe(out);
      expect(existsSync(out)).toBe(true);
    },
    LONG,
  );

  describe("the messy fixture", () => {
    let messy = "";
    beforeAll(() => {
      messy = fixture("messy_all", "all");
    }, LONG);

    it(
      "fixes each fixable habit and reports every other one with its hint (with --retime)",
      async () => {
        const { r, out, hitboxes } = await run(messy, true);
        expect(r.stage).toBe("export");
        expect(r.problems).toHaveLength(4);
        const problems = r.problems.join("\n");
        // Empties with a display size but no cf_radius: named, with the display size as the value to use.
        expect(problems).toContain("'hurt_body' has no custom property cf_radius. glTF does not export an empty's display size");
        expect(problems).toContain("add cf_radius = 0.4 (its display size)");
        expect(problems).toContain("'hit_beak' has no custom property cf_radius");
        expect(problems).toContain("add cf_radius = 0.14 (its display size)");
        // The stray default action, by name.
        expect(problems).toContain("stray action 'Action': 'Action' is the name Blender gives a new action");
        // An attack clip that doesn't match moves.json and has no cf_phases: the numbers.
        expect(problems).toContain("attack clip 'peck' is 18 frames at 60 fps (7.2 at the file's rate), but moves.json peck lasts 4 + 2 + 8 = 14 frames");
        expect(problems).toContain("add a custom property cf_phases = [startup, active, recovery]");

        const fixes = r.fixes.join("\n");
        expect(fixes).toContain("left Pose mode for Object mode");
        expect(fixes).toContain("'Rig' was showing its Rest Position");
        expect(fixes).toContain("--retime: the scene ran at 24 fps; every clip is scaled by 60/24 = 2.5");
        expect(fixes).toContain("retimed attack 'shove' from its authored split [16, 6, 32] (54 frames) to the contract's [8, 3, 16] (27 frames)");
        // Actions not on NLA tracks (including the active-only 'win') get name-matched tracks.
        expect(fixes).toMatch(/put 21 actions that were not on NLA tracks onto tracks named after them: .*\bwin\b/);
        // Non-deform IK/control bones are fine: excluded from the export.
        expect(r.notes.join("\n")).toContain("3 non-deform bones stay in Blender and are not exported (control/IK bones are fine): ctrl_foot_L, ctrl_foot_R, ctrl_look");

        expect(existsSync(out)).toBe(false);
        expect(existsSync(hitboxes)).toBe(false);
      },
      LONG,
    );

    it(
      "without --retime, a 24 fps scene fails with the frame-rate hint (lengths wait for it)",
      async () => {
        const { r } = await run(messy);
        expect(r.stage).toBe("export");
        const fps = r.problems.find((p) => p.startsWith("the scene runs at 24 fps"));
        expect(fps).toBe(
          "the scene runs at 24 fps, but clips are authored at 60 fps (1 frame = 1 sim tick). If your keys already sit on the " +
            "contract's 60 fps frame counts, set Output Properties > Frame Rate to 60 and save. If you animated at 24 fps by eye, " +
            "re-run with --retime: every action is scaled by 60/24 = 2.5 so it keeps its real-time length (clip lengths are checked " +
            "once the frame rate is fixed)",
        );
        expect(r.problems.some((p) => p.includes("'peck'"))).toBe(false);
        expect(r.problems).toHaveLength(4); // fps, the stray action, two radii
      },
      LONG,
    );

    it(
      "exits 1 through the CLI, listing the problems once",
      () => {
        const res = spawnSync(
          repoPath("tools", "node_modules", ".bin", "tsx"),
          ["src/cli/import.ts", "--blend", messy, "--out", join(tmp, "cli.glb"), "--hitboxes", join(tmp, "cli.json"), "--retime"],
          { cwd: repoPath("tools"), encoding: "utf8", env: { ...process.env, BLENDER: blender!, INIT_CWD: repoPath() } },
        );
        expect(res.status).toBe(1);
        expect(res.stdout).toContain("[1/3] export FAILED (4 problems): fix them in Blender, save, and run the import again");
        expect(res.stdout).toMatch(/\n {2}1\. 'hurt_body' has no custom property cf_radius/);
        expect(res.stdout).not.toContain("CF_ERROR"); // Blender's raw output is summarized, not dumped
      },
      LONG,
    );
  });

  it(
    "the fixable habits (60 fps) import to the placeholder's clips",
    async () => {
      const { r, hitboxes } = await run(fixture("messy_fixable", "fixable"));
      expect(r.problems).toEqual([]);
      expect(r.ok).toBe(true);
      expect(r.fixes.join("\n")).toMatch(/put 21 actions.*unhid hit_beak, hurt_body/s);
      // Frame-1 starts are slid to 0 by the exporter, shove is retimed back phase by phase: the bake matches.
      expect(worstDiff(JSON.parse(readFileSync(hitboxes, "utf8")) as HitboxesFile)).toBeLessThanOrEqual(1);
    },
    LONG,
  );

  it(
    "a file animated at 24 fps imports with --retime to the placeholder's clips",
    async () => {
      const blend = fixture("messy_24fps", "fps24,frame1,off_nla,active_action,ctrl_bones,pose_mode,hidden_helpers");
      const { r, hitboxes } = await run(blend, true);
      expect(r.problems).toEqual([]);
      expect(r.fixes.join("\n")).toContain("retimed 21 clips to their contract lengths");
      expect(worstDiff(JSON.parse(readFileSync(hitboxes, "utf8")) as HitboxesFile)).toBeLessThanOrEqual(1);
    },
    LONG,
  );

  it(
    "the UI preset is valid inside Blender and exports the same glb as the scripted export",
    async () => {
      const presetGlb = join(tmp, "preset.glb");
      const res = blenderRun("tools/test/blender/check_preset.py", ["--out", presetGlb], placeholderBlend);
      expect(res.stdout).toMatch(/CF_PRESET_OK \d+ settings/);
      const { out } = await run(placeholderBlend);
      expect(readFileSync(presetGlb).equals(readFileSync(out))).toBe(true);
    },
    LONG,
  );
});
