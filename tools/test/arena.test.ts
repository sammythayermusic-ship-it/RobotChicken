/**
 * Arena rules (assets:validate --arena) on small in-memory arenas: the
 * triangle budget counts GPU instances, the lightmap is at most 4096 and
 * reaches every mesh through TEXCOORD_1, and no arena file is a clean skip.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Document } from "@gltf-transform/core";
import { EXTMeshGPUInstancing, KHRTextureBasisu } from "@gltf-transform/extensions";
import { validateArenaDocument, validateArenaGlb } from "../src/assets/arena";
import { getIO } from "../src/assets/gltf";
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

/** An arena of one triangle-soup node per spec (every triangle is the same 3 vertices: only counts matter). */
function arena(meshes: MeshSpec[]): Document {
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

describe("assets:validate --arena", () => {
  const tsx = repoPath("tools", "node_modules", ".bin", "tsx");
  const run = (...args: string[]) =>
    spawnSync(tsx, ["src/cli/validate.ts", ...args], { cwd: repoPath("tools"), encoding: "utf8", env: { ...process.env, INIT_CWD: repoPath() } });

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
