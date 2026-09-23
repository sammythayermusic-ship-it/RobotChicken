import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Document } from "@gltf-transform/core";
import { CONTRACT, PLACEHOLDER_GLB, fromRepo, readGlb, readHitboxes, userCwd, userPath } from "../src/assets/gltf";
import { repoPath } from "../src/root";
import { clipNameHint, levenshtein, validateDocument, validateFile, validateGlb, type Issue } from "../src/assets/validate";

const glbPath = fromRepo(PLACEHOLDER_GLB);
const bytes = new Uint8Array(readFileSync(glbPath));
const errors = (issues: Issue[]) => issues.filter((i) => i.severity === "error");
const errorsOf = (doc: Document) => errors(validateDocument(doc).issues);
const node = (doc: Document, name: string) => doc.getRoot().listNodes().find((n) => n.getName() === name)!;
const anim = (doc: Document, name: string) => doc.getRoot().listAnimations().find((a) => a.getName() === name)!;

describe("the committed placeholder", () => {
  it("passes with no errors or warnings (gltf-validator, contract, hitboxes sha256)", async () => {
    const r = await validateFile(glbPath, { hitboxes: readHitboxes(), file: PLACEHOLDER_GLB });
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.stats.validator?.errors).toBe(0);
    expect(r.stats.joints).toBeLessThanOrEqual(CONTRACT.budgets.joints);
    expect(r.stats.triangles).toBeLessThanOrEqual(CONTRACT.budgets.chickenTriangles);
    expect(r.stats.clips).toBe(21);
    expect(r.stats.materials).toEqual([...CONTRACT.materials].sort());
  });
});

describe("mutated copies fail", () => {
  it("a renamed clip is missing, with a near-miss hint", async () => {
    const doc = await readGlb(bytes);
    anim(doc, "peck").setName("Peck");
    const errs = errorsOf(doc);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatchObject({ code: "clips" });
    expect(errs[0]!.message).toContain('missing clip "peck"');
    expect(errs[0]!.message).toContain('found "Peck"');
  });

  it("a multi-slot export name points at the slot problem", async () => {
    const doc = await readGlb(bytes);
    anim(doc, "slam").setName("slam-Rig");
    expect(errorsOf(doc)[0]!.message).toMatch(/found "slam-Rig": an action with several slots/);
  });

  it("a stray extra clip is an error", async () => {
    const doc = await readGlb(bytes);
    const stray = doc.createAnimation("Action");
    for (const s of anim(doc, "idle").listSamplers()) stray.addSampler(s);
    for (const ch of anim(doc, "idle").listChannels()) stray.addChannel(ch);
    expect(errorsOf(doc).map((e) => e.message)).toEqual([expect.stringContaining('unexpected clip "Action"')]);
  });

  it("root motion is an error", async () => {
    const doc = await readGlb(bytes);
    const ch = anim(doc, "walk_fwd")
      .listChannels()
      .find((c) => c.getTargetNode()?.getName() === "root" && c.getTargetPath() === "translation")!;
    const out = ch.getSampler()!.getOutput()!;
    const moved = Float32Array.from(out.getArray()!);
    moved[moved.length - 1] = moved[moved.length - 1]! + 0.5; // last key's z: the root walks forward
    out.setArray(moved);
    const errs = errorsOf(doc);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.every((e) => e.code === "root-motion")).toBe(true);
    expect(errs.map((e) => e.message)).toContain(
      'clip "walk_fwd" moves "root" (root motion is off: the sim owns position; animate "body" instead)',
    );
  });

  it("missing helper extras are errors", async () => {
    const doc = await readGlb(bytes);
    node(doc, "hurt_body").setExtras({});
    const errs = errorsOf(doc);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.every((e) => e.code === "helpers")).toBe(true);
    expect(errs.map((e) => e.message).join("\n")).toMatch(/cf_shape[\s\S]*cf_radius[\s\S]*cf_half_height/);
  });

  it("exceeding the joint budget is an error", async () => {
    const doc = await readGlb(bytes);
    const skin = doc.getRoot().listSkins()[0]!;
    const root = node(doc, "root");
    for (let i = 0; i < CONTRACT.budgets.joints; i++) {
      const extra = doc.createNode(`extra_${i}`);
      root.addChild(extra);
      skin.addJoint(extra);
    }
    const errs = errorsOf(doc);
    expect(errs.map((e) => e.code)).toEqual(["joints"]);
    expect(errs[0]!.message).toContain(`exceeds the budget of ${CONTRACT.budgets.joints}`);
  });

  it("a retimed clip (wrong frame count) is an error", async () => {
    const doc = await readGlb(bytes);
    // Samplers (and clips of the same length) may share one input accessor: scale each accessor once.
    for (const input of new Set(anim(doc, "peck").listSamplers().map((s) => s.getInput()!))) {
      input.setArray(Float32Array.from(input.getArray() as Float32Array, (t) => t * 2.5)); // as if authored at 24 fps
    }
    expect(errorsOf(doc).map((e) => e.message)).toContain(
      'clip "peck" has 35 frames; the contract needs exactly 14 (sim frame f = clip sample f)',
    );
  });

  it("a beak behind the body (wrong facing) is an error", async () => {
    const doc = await readGlb(bytes);
    const beak = node(doc, "hit_beak");
    const [x, y, z] = beak.getTranslation();
    beak.setTranslation([x, y, -z - 0.6]);
    const codes = errorsOf(doc).map((e) => e.code);
    expect(codes).toContain("facing");
    expect(codes).toContain("active");
  });

  it("a stale hitboxes.json sha256 is an error", async () => {
    const hitboxes = { ...readHitboxes(), source: { file: PLACEHOLDER_GLB, sha256: "0".repeat(64) } };
    const r = await validateGlb(bytes, { file: PLACEHOLDER_GLB, hitboxes });
    expect(r.ok).toBe(false);
    expect(errors(r.issues).map((e) => e.code)).toEqual(["hitboxes"]);
    expect(errors(r.issues)[0]!.message).toContain("run pnpm assets:bake");
  });

  it("gltf-validator errors fail the file", async () => {
    const r = await validateGlb(bytes.slice(0, bytes.length - 4096), { file: "truncated.glb", hitboxes: null });
    expect(r.ok).toBe(false);
    expect(errors(r.issues).some((e) => e.code === "gltf-validator")).toBe(true);
  });
});

describe("clip name hints", () => {
  it("measures edit distance", () => {
    expect(levenshtein("peck", "peck")).toBe(0);
    expect(levenshtein("peck", "pekc")).toBe(2);
    expect(levenshtein("slam", "slams")).toBe(1);
    expect(levenshtein("", "abc")).toBe(3);
  });

  it("finds case, separator, slot-suffix and typo near misses", () => {
    expect(clipNameHint("peck", ["Action", "Peck"])).toBe("Peck");
    expect(clipNameHint("walk_fwd", ["walk.fwd"])).toBe("walk.fwd");
    expect(clipNameHint("walk_fwd", ["Walk Fwd"])).toBe("Walk Fwd");
    expect(clipNameHint("peck", ["peck-Rig"])).toBe("peck-Rig");
    expect(clipNameHint("dive_kick", ["dive_kik"])).toBe("dive_kik");
    expect(clipNameHint("hit_heavy", ["hit_light", "hit_heavvy"])).toBe("hit_heavvy");
  });

  it("does not hint unrelated names", () => {
    expect(clipNameHint("idle", ["Action", "entrance_2"])).toBeUndefined();
    expect(clipNameHint("walk_fwd", ["walk_back"])).toBeUndefined();
  });
});

describe("command-line paths", () => {
  it("resolve against CF_CWD, then INIT_CWD, then the process cwd, skipping empty values", () => {
    expect(userCwd({ CF_CWD: "/user/dir", INIT_CWD: "/repo" })).toBe("/user/dir");
    expect(userCwd({ CF_CWD: "", INIT_CWD: "/repo" })).toBe("/repo");
    expect(userCwd({ INIT_CWD: "" })).toBe(process.cwd());
    expect(userPath("../a.glb", { CF_CWD: "/repo/docs", INIT_CWD: "/repo" })).toBe("/repo/a.glb");
  });

  const hasPnpm = spawnSync("pnpm", ["--version"]).status === 0;
  it.skipIf(!hasPnpm)("the root wrapper resolves a path relative to where the user ran it, not the repo root", () => {
    // The wrapper's nested pnpm resets INIT_CWD to the repo root; the wrapper forwards the user's directory as CF_CWD.
    const run = spawnSync("pnpm", ["-s", "assets:validate", `../${PLACEHOLDER_GLB}`, "--json"], { cwd: repoPath("docs"), encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ file: PLACEHOLDER_GLB, ok: true });
  });
});
