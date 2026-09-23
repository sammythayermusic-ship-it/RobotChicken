/**
 * Arena rules (`pnpm assets:validate --arena [file]`), for Sammy's arena.glb
 * when it exists; the procedural junkyard needs no files, so no arena file is
 * a clean skip.
 *
 * Budgets (spec): at most 60k triangles in total, counting every node that
 * draws a mesh and every GPU instance; lighting baked into one lightmap of at
 * most 4096 px, read through TEXCOORD_1 (three.js: `material.lightMap` with
 * `texture.channel = 1`). The lightmap is either arena_lightmap.ktx2 next to
 * the glb or a texture the glb reads through TEXCOORD_1.
 */
import { existsSync, readFileSync } from "node:fs";
import type { Document, Node } from "@gltf-transform/core";
import type { InstancedMesh } from "@gltf-transform/extensions";
import { getGLPrimitiveCount } from "@gltf-transform/functions";
import validator from "gltf-validator";
import { CONTRACT, readGlb, sha256, toRepo, type Contract } from "./gltf";
import { imageInfo, isPowerOfTwo } from "./images";
import { checkDocumentTextures } from "./textures";
import { ALLOWED_EXTENSIONS, type Issue, type ValidateReport } from "./validate";

/** GPU instancing is fine for an arena (three's GLTFLoader builds InstancedMesh from it). */
const ARENA_EXTENSIONS = [...ALLOWED_EXTENSIONS, "EXT_mesh_gpu_instancing"];

/** How many times a node draws its mesh: its GPU instance count, else 1. */
function instances(n: Node): number {
  const ext = n.getExtension<InstancedMesh>("EXT_mesh_gpu_instancing");
  return ext?.listAttributes()[0]?.getCount() ?? 1;
}

/** Document rules; `lightmap` is the bytes of arena_lightmap.ktx2 when that file exists. */
export function validateArenaDocument(
  doc: Document,
  opts: { contract?: Contract; lightmap?: { file: string; bytes: Uint8Array } | null } = {},
): { issues: Issue[]; triangles: number } {
  const contract = opts.contract ?? CONTRACT;
  const issues: Issue[] = [];
  const err = (code: string, message: string) => issues.push({ severity: "error", code, message });
  const warn = (code: string, message: string) => issues.push({ severity: "warning", code, message });
  const root = doc.getRoot();

  for (const e of root.listExtensionsUsed()) {
    if (!ARENA_EXTENSIONS.includes(e.extensionName)) err("extensions", `extension ${e.extensionName} is not supported by the web runtime`);
  }

  let triangles = 0;
  const drawn = root.listNodes().filter((n) => n.getMesh());
  for (const n of drawn) {
    const count = instances(n);
    for (const p of n.getMesh()!.listPrimitives()) {
      if (p.getMode() >= 4) triangles += getGLPrimitiveCount(p) * count;
    }
  }
  const budget = contract.budgets.arenaTriangles;
  if (triangles > budget) err("budget", `the arena draws ${triangles} triangles (instances included), over the budget of ${budget}`);

  const tex = checkDocumentTextures(doc, { maxSize: contract.budgets.textureSize, lightmapMax: contract.budgets.lightmapSize });
  issues.push(...tex.issues);

  const lightmapMax = contract.budgets.lightmapSize;
  const lm = opts.lightmap;
  if (lm) {
    const info = imageInfo(lm.bytes);
    if (info.format !== "ktx2") err("lightmap", `${lm.file} is not a KTX2 file: convert it with ktx create (docs/art-pipeline.md, Textures)`);
    else if (info.width > lightmapMax || info.height > lightmapMax) err("lightmap", `${lm.file} is ${info.width}x${info.height}, over the ${lightmapMax} limit`);
    else if (!isPowerOfTwo(info.width) || !isPowerOfTwo(info.height)) err("lightmap", `${lm.file} is ${info.width}x${info.height}; both sides must be powers of two`);
  }
  const uv1Textures = root.listMaterials().some((m) =>
    (
      [
        [m.getBaseColorTexture(), m.getBaseColorTextureInfo()],
        [m.getEmissiveTexture(), m.getEmissiveTextureInfo()],
        [m.getOcclusionTexture(), m.getOcclusionTextureInfo()],
        [m.getNormalTexture(), m.getNormalTextureInfo()],
        [m.getMetallicRoughnessTexture(), m.getMetallicRoughnessTextureInfo()],
      ] as const
    ).some(([tex, info]) => tex && info?.getTexCoord() === 1),
  );
  if (lm || uv1Textures) {
    const missing = [...new Set(drawn.filter((n) => n.getMesh()!.listPrimitives().some((p) => !p.getAttribute("TEXCOORD_1"))).map((n) => n.getName() || "(unnamed)"))];
    if (missing.length) {
      err("lightmap", `${missing.length} mesh node(s) have no TEXCOORD_1, so the lightmap can't reach them: ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? ", ..." : ""} (bake the lightmap UVs into the second UV map)`);
    }
  } else if (drawn.length) {
    warn("lightmap", "no lightmap (arena_lightmap.ktx2 next to the glb, or a texture read through TEXCOORD_1): the spec bakes the arena's lighting into one");
  }
  return { issues, triangles };
}

export async function validateArenaGlb(
  bytes: Uint8Array,
  opts: { file: string; contract?: Contract; lightmap?: { file: string; bytes: Uint8Array } | null },
): Promise<ValidateReport> {
  const issues: Issue[] = [];
  const report = await validator.validateBytes(bytes, { maxIssues: 0 });
  for (const m of report.issues.messages.filter((x) => x.severity === 0).slice(0, 20)) {
    issues.push({ severity: "error", code: "gltf-validator", message: `${m.code} at ${m.pointer ?? "?"}: ${m.message}` });
  }
  let triangles: number | undefined;
  try {
    const r = validateArenaDocument(await readGlb(bytes), opts);
    issues.push(...r.issues);
    triangles = r.triangles;
  } catch (e) {
    issues.push({ severity: "error", code: "parse", message: `cannot read the glb: ${(e as Error).message}` });
  }
  const errors = issues.filter((i) => i.severity === "error").length;
  return {
    file: opts.file,
    ok: errors === 0,
    errors,
    warnings: issues.length - errors,
    issues,
    stats: {
      bytes: bytes.length,
      sha256: sha256(bytes),
      triangles,
      validator: { version: validator.version(), errors: report.issues.numErrors, warnings: report.issues.numWarnings },
    },
  };
}

/** Validate the arena at `path` with its lightmap at `lightmapPath` (when that file exists). */
export async function validateArenaFile(path: string, lightmapPath: string, contract: Contract = CONTRACT): Promise<ValidateReport> {
  const lightmap = existsSync(lightmapPath) ? { file: toRepo(lightmapPath), bytes: new Uint8Array(readFileSync(lightmapPath)) } : null;
  return validateArenaGlb(new Uint8Array(readFileSync(path)), { file: toRepo(path), contract, lightmap });
}
