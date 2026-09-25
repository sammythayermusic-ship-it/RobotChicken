/**
 * Arena rules (assets:validate, whenever an arena exists) on small in-memory
 * arenas: the triangle budget counts GPU instances, the lightmap is at most
 * 4096 and reaches every mesh through TEXCOORD_1, the anchor empties the game
 * reads are there (ring edges exactly at x = ±10), and no arena file is a
 * clean skip.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Document } from "@gltf-transform/core";
import { EXTMeshGPUInstancing, KHRTextureBasisu } from "@gltf-transform/extensions";
import { checkArenaAnchors, validateArenaDocument, validateArenaGlb, validateArenaIfPresent } from "../src/assets/arena";
import { ARENA_GLB, getIO } from "../src/assets/gltf";
import { repoPath } from "../src/root";
import { fakeKtx2 } from "./helpers/images";

const tmp = mkdtempSync(join(tmpdir(), "cf-arena-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

interface MeshSpec {
  name: string;
  tris: number;
  uv1?: boolean;
  instances?: number;
}

/** Empties (name -> world position, optional extras) a complete arena carries, as in layout.ts PROCEDURAL_ANCHORS. */
type Anchors = Record<string, { at: [number, number, number]; extras?: Record<string, unknown> }>;
const ANCHORS: Anchors = {
  ringedge_L: { at: [-10, 0, 0] },
  ringedge_R: { at: [10, 0, 0] },
  fire_L1: { at: [-8.35, 0, -5.55] },
  fire_L2: { at: [-7.3, 0, -6.35] },
  fire_R1: { at: [8.35, 0, -5.55] },
  crowd_1_a: { at: [-17, 2.3, -12.35], extras: { count: 30 } },
  crowd_1_b: { at: [17, 2.3, -12.35] },
  flood_1: { at: [-14.6, 8.6, -10.6] },
  flood_1_target: { at: [-2.6, 0, -0.8] },
};

function addAnchors(doc: Document, anchors: Anchors): void {
  const scene = doc.getRoot().listScenes()[0] ?? doc.createScene();
  for (const [name, a] of Object.entries(anchors)) scene.addChild(doc.createNode(name).setTranslation(a.at).setExtras(a.extras ?? {}));
}

/** An arena of one triangle-soup node per spec (every triangle is the same 3 vertices: only counts matter), plus the anchor empties. */
function arena(meshes: MeshSpec[], anchors: Anchors = ANCHORS): Document {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene();
  const vec = (type: "VEC2" | "VEC3", values: number[]) => doc.createAccessor().setType(type).setArray(new Float32Array(values)).setBuffer(buffer);
  for (const m of meshes) {
    const prim = doc
      .createPrimitive()
      .setAttribute("POSITION", vec("VEC3", [0, 0, 0, 1, 0, 0, 0, 1, 0]))
      .setIndices(doc.createAccessor().setType("SCALAR").setArray(Uint16Array.from({ length: m.tris * 3 }, (_, i) => i % 3)).setBuffer(buffer));
    prim.setAttribute("TEXCOORD_0", vec("VEC2", [0, 0, 1, 0, 0, 1]));
    if (m.uv1 ?? true) prim.setAttribute("TEXCOORD_1", vec("VEC2", [0, 0, 1, 0, 0, 1]));
    const node = doc.createNode(m.name).setMesh(doc.createMesh(m.name).addPrimitive(prim));
    if (m.instances) {
      const ext = doc.createExtension(EXTMeshGPUInstancing);
      const offsets = vec("VEC3", Array.from({ length: m.instances * 3 }, (_, i) => i));
      node.setExtension("EXT_mesh_gpu_instancing", ext.createInstancedMesh().setAttribute("TRANSLATION", offsets));
    }
    scene.addChild(node);
  }
  addAnchors(doc, anchors);
  return doc;
}

const lightmap = (width: number) => ({ file: "arena_lightmap.ktx2", bytes: fakeKtx2({ width }) });
const errorsOf = (r: ReturnType<typeof validateArenaDocument>) => r.issues.filter((i) => i.severity === "error").map((i) => `[${i.code}] ${i.message}`);

describe("arena rules", () => {
  it("pass a lightmapped arena under budget", () => {
    const r = validateArenaDocument(arena([{ name: "floor", tris: 20_000 }, { name: "walls", tris: 30_000 }]), { lightmap: lightmap(4096) });
    expect(r.triangles).toBe(50_000);
    expect(r.issues).toEqual([]);
  });

  it("fail over 60k triangles, counting GPU instances", () => {
    expect(errorsOf(validateArenaDocument(arena([{ name: "floor", tris: 61_000 }]), { lightmap: lightmap(2048) }))).toEqual([
      "[budget] the arena draws 61000 triangles (instances included), over the budget of 60000",
    ]);
    const tires = validateArenaDocument(arena([{ name: "tire", tris: 1_000, instances: 61 }]), { lightmap: lightmap(2048) });
    expect(tires.triangles).toBe(61_000);
    expect(errorsOf(tires)).toEqual(["[budget] the arena draws 61000 triangles (instances included), over the budget of 60000"]);
  });

  it("fail when a mesh has no TEXCOORD_1 for the lightmap", () => {
    const r = validateArenaDocument(arena([{ name: "floor", tris: 10 }, { name: "car", tris: 10, uv1: false }]), { lightmap: lightmap(4096) });
    expect(errorsOf(r)).toEqual([
      "[lightmap] 1 mesh node(s) have no TEXCOORD_1, so the lightmap can't reach them: car (bake the lightmap UVs into the second UV map)",
    ]);
  });

  it("fail on a lightmap over 4096 (file or a texture read through TEXCOORD_1)", () => {
    expect(errorsOf(validateArenaDocument(arena([{ name: "floor", tris: 10 }]), { lightmap: lightmap(8192) }))).toEqual([
      "[lightmap] arena_lightmap.ktx2 is 8192x8192, over the 4096 limit",
    ]);
    const embedded = (width: number) => {
      const doc = arena([{ name: "floor", tris: 10 }]);
      doc.createExtension(KHRTextureBasisu);
      const tex = doc.createTexture("lightmap").setImage(fakeKtx2({ width })).setMimeType("image/ktx2");
      const mat = doc.createMaterial("floor").setEmissiveTexture(tex);
      mat.getEmissiveTextureInfo()!.setTexCoord(1);
      doc.getRoot().listMeshes()[0]!.listPrimitives()[0]!.setMaterial(mat);
      return validateArenaDocument(doc);
    };
    expect(errorsOf(embedded(4096))).toEqual([]);
    expect(errorsOf(embedded(8192))).toEqual(['[textures] texture "lightmap" is 8192x8192, over the 4096 limit']);
  });

  it("only warn when there is no lightmap at all", () => {
    const r = validateArenaDocument(arena([{ name: "floor", tris: 10, uv1: false }]));
    expect(r.issues.map((i) => i.severity)).toEqual(["warning"]);
    expect(r.issues[0]!.message).toContain("no lightmap");
  });

  it("validates a written glb end to end (gltf-validator included)", async () => {
    const bytes = await (await getIO()).writeBinary(arena([{ name: "floor", tris: 100 }]));
    const r = await validateArenaGlb(bytes, { file: "arena.glb", lightmap: lightmap(1024) });
    expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(r.stats.triangles).toBe(100);
  });
});

describe("arena anchors (the empties anchorsFromScene reads)", () => {
  const anchorIssues = (anchors: Anchors) => checkArenaAnchors(arena([], anchors)).map((i) => `${i.severity}: ${i.message}`);
  const without = (...names: string[]) => Object.fromEntries(Object.entries(ANCHORS).filter(([n]) => !names.includes(n)));

  it("pass a complete set", () => {
    expect(anchorIssues(ANCHORS)).toEqual([]);
  });

  it("fail without a ring edge, or with one away from x = ±10 (world position, parents included)", () => {
    expect(anchorIssues(without("ringedge_R"))).toEqual([
      "error: no empty named ringedge_R: add one at x = 10 (the ring edge; the game would silently assume it, and the sim rings fighters out there)",
    ]);
    expect(anchorIssues({ ...ANCHORS, ringedge_L: { at: [-9.9, 0, 0] } })).toEqual([
      "error: ringedge_L is at x = -9.900; it must be at x = -10 (±0.05), where the sim rings fighters out",
    ]);
    const nested = arena([], without("ringedge_L"));
    const parent = nested.createNode("lip").setTranslation([-5, 0, 0]).addChild(nested.createNode("ringedge_L").setTranslation([-5.02, 0.1, 0]));
    nested.getRoot().listScenes()[0]!.addChild(parent);
    expect(checkArenaAnchors(nested)).toEqual([]);
  });

  it("warn when a fire, crowd or flood group would fall back to the procedural layout", () => {
    expect(anchorIssues(without("fire_R1", "crowd_1_b", "flood_1_target"))).toEqual([
      "warning: no fire_R* empties (one per oil drum): the right fire cluster falls back to the procedural drums",
      "warning: crowd_1_a has no crowd_1_b: that crowd row is skipped",
      "warning: no crowd_<n>_a / crowd_<n>_b pairs: the crowd falls back to the procedural bleachers",
      "warning: flood_1 has no flood_1_target: that floodlight is skipped",
      "warning: no flood_<n> / flood_<n>_target pairs: the floodlights fall back to the procedural towers",
    ]);
    expect(anchorIssues({ ...ANCHORS, crowd_1_a: { at: [-17, 2.3, -12.35], extras: { count: "lots" } } })).toEqual([
      'warning: crowd_1_a has count = "lots"; it must be a positive number (the row uses 30)',
    ]);
  });

  it("read names the way three's GLTFLoader hands them to the game (Blender's fire_L.001 is fire_L001)", () => {
    expect(anchorIssues({ ...without("fire_L1", "fire_L2"), "fire_L.001": { at: [-8, 0, -5] } })).toEqual([]);
  });

  it("are part of the arena rules", () => {
    expect(errorsOf(validateArenaDocument(arena([{ name: "floor", tris: 10 }], without("ringedge_L", "ringedge_R")), { lightmap: lightmap(1024) }))).toEqual([
      "[anchors] no empty named ringedge_L: add one at x = -10 (the ring edge; the game would silently assume it, and the sim rings fighters out there)",
      "[anchors] no empty named ringedge_R: add one at x = 10 (the ring edge; the game would silently assume it, and the sim rings fighters out there)",
    ]);
  });
});

describe("assets:validate and the arena", () => {
  const tsx = repoPath("tools", "node_modules", ".bin", "tsx");
  const run = (...args: string[]) =>
    spawnSync(tsx, ["src/cli/validate.ts", ...args], { cwd: repoPath("tools"), encoding: "utf8", env: { ...process.env, INIT_CWD: repoPath() } });

  it("runs the arena rules without --arena (so CI checks an arena as soon as one lands), skipping cleanly with none", () => {
    // No arena is committed yet; the arena step still runs and says it skipped.
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`arena: no ${ARENA_GLB} (the procedural junkyard needs no files); arena rules skipped`);
  });

  it("validates whatever arena file is there", async () => {
    const path = join(tmp, "present", "arena.glb");
    expect(await validateArenaIfPresent(path)).toEqual({ skipped: `arena: no ${path} (the procedural junkyard needs no files); arena rules skipped` });
    mkdirSync(join(tmp, "present"), { recursive: true });
    writeFileSync(path, await (await getIO()).writeBinary(arena([{ name: "floor", tris: 100 }], {})));
    const r = await validateArenaIfPresent(path);
    expect("report" in r && r.report.issues.filter((i) => i.severity === "error").map((i) => i.code)).toEqual(["anchors", "anchors"]);
  });

  it("skips cleanly when there is no arena file", () => {
    const r = run(`--arena=${join(tmp, "missing.glb")}`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("missing.glb (the procedural junkyard needs no files); arena rules skipped");
  });

  it("fails on an arena over budget", async () => {
    const path = join(tmp, "arena.glb");
    writeFileSync(path, await (await getIO()).writeBinary(arena([{ name: "floor", tris: 61_000 }])));
    const r = run(`--arena=${path}`);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("[budget] the arena draws 61000 triangles");
  });
});
