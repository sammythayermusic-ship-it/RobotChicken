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
/** The next float32 above a positive t (0 stays 0). */
const nextUp32 = (t: number) => {
  if (t <= 0) return t;
  const f = new Float32Array([t]);
  const bits = new Uint32Array(f.buffer);
  bits[0] = bits[0]! + 1;
  return f[0]!;
};

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

  it("a STEP key stored a hair after its frame's float32 time is a warning (three.js would show it a frame late)", async () => {
    const stepPeck = async (shift: (t: number) => number) => {
      const doc = await readGlb(bytes);
      const sampler = anim(doc, "peck")
        .listSamplers()
        .find((s) => s.getInterpolation() === "LINEAR" && s.getInput()!.getCount() > 2)!;
      const times = Float32Array.from(sampler.getInput()!.getArray()!, shift);
      sampler.setInput(doc.createAccessor().setType("SCALAR").setArray(times)).setInterpolation("STEP");
      return validateDocument(doc).issues;
    };
    // Blender's exporter writes key f at exactly Math.fround(f / 60): stepping that is fine.
    expect(await stepPeck((t) => t)).toEqual([]);
    const late = await stepPeck(nextUp32);
    expect(errors(late)).toEqual([]);
    expect(late.map((i) => i.message)).toEqual([expect.stringContaining('clip "peck" has STEP keys stored just after their frame time')]);
  });

  it("an extra unskinned mesh is an error, and its triangles and materials count", async () => {
    const base = validateDocument(await readGlb(bytes)).stats.triangles!;
    const doc = await readGlb(bytes);
    const tris = 60_000;
    const prim = doc
      .createPrimitive()
      .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setArray(new Float32Array([0, 0, 0, 0.1, 0, 0, 0, 0.1, 0])))
      .setIndices(doc.createAccessor().setType("SCALAR").setArray(Uint32Array.from({ length: tris * 3 }, (_, i) => i % 3)))
      .setMaterial(doc.createMaterial("not_a_slot"));
    node(doc, "head").addChild(doc.createNode("crest").setMesh(doc.createMesh("crest").addPrimitive(prim)));
    const r = validateDocument(doc);
    expect(r.stats.triangles).toBe(base + tris);
    expect(r.stats.materials).toContain("not_a_slot");
    const errs = errors(r.issues);
    expect(errs.map((e) => e.code).sort()).toEqual(["budget", "materials", "mesh"]);
    expect(errs.find((e) => e.code === "mesh")!.message).toContain('mesh node "crest" is not skinned (it follows bone "head" rigidly)');
  });

  it("a chicken modeled off the origin (root and its keys moved forward) is an error", async () => {
    const doc = await readGlb(bytes);
    const root = node(doc, "root");
    root.setTranslation([0, 0, 0.3]);
    // Clips may share one output accessor: shift each accessor once.
    const outputs = new Set(
      doc
        .getRoot()
        .listAnimations()
        .flatMap((a) => a.listChannels())
        .filter((c) => c.getTargetNode() === root && c.getTargetPath() === "translation")
        .map((c) => c.getSampler()!.getOutput()!),
    );
    expect(outputs.size).toBeGreaterThan(0);
    for (const out of outputs) out.setArray(Float32Array.from(out.getArray() as Float32Array, (v, i) => (i % 3 === 2 ? v + 0.3 : v)));
    const errs = errorsOf(doc);
    expect(errs.map((e) => e.code).sort()).toEqual(["center", "root"]);
    expect(errs.find((e) => e.code === "root")!.message).toContain('"root" rests at (0.000, 0.000, 0.300); it must sit at the origin');
  });

  it("a body off-center over a root at the origin is an error", async () => {
    const doc = await readGlb(bytes);
    const hurt = node(doc, "hurt_body");
    const [x, y, z] = hurt.getTranslation();
    hurt.setTranslation([x, y, z + 0.1]);
    const errs = errorsOf(doc);
    expect(errs.map((e) => e.code)).toEqual(["center"]);
    expect(errs[0]!.message).toContain('at idle frame 0 "hurt_body" is centered at x=0.000 z=0.100');
  });

  it("a mesh off-center left-right is a warning", async () => {
    const doc = await readGlb(bytes);
    const positions = new Set(doc.getRoot().listMeshes().flatMap((m) => m.listPrimitives().map((p) => p.getAttribute("POSITION")!)));
    for (const pos of positions) pos.setArray(Float32Array.from(pos.getArray() as Float32Array, (v, i) => (i % 3 === 0 ? v + 0.1 : v)));
    const r = validateDocument(doc);
    expect(errors(r.issues)).toEqual([]);
    expect(r.issues.map((i) => i.message)).toEqual(["the chicken is centered at x=0.100; it should be centered left-right on x=0"]);
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
    // On GitHub Actions pnpm wraps filtered output in ::group:: annotations, so
    // drop that env for the child (and read the JSON document, not stray lines).
    const env = { ...process.env, GITHUB_ACTIONS: "", CI: "" };
    const run = spawnSync("pnpm", ["-s", "assets:validate", `../${PLACEHOLDER_GLB}`, "--json"], { cwd: repoPath("docs"), encoding: "utf8", env });
    expect(run.status, run.stderr).toBe(0);
    // pnpm's engine warnings (e.g. Node 24 on a Mac) print `wanted: {"node":"22.x"}` first, so start at a line that opens with "{".
    const json = run.stdout.slice(run.stdout.search(/^\{/m), run.stdout.lastIndexOf("}") + 1);
    expect(JSON.parse(json)).toMatchObject({ file: PLACEHOLDER_GLB, ok: true });
  });
});
