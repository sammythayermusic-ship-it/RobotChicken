/**
 * Arena rules, run by every `pnpm assets:validate` (and so CI) on Sammy's
 * arena.glb when it exists (`--arena=<file>` for another file); the procedural
 * junkyard needs no files, so no arena file is a clean skip.
 *
 * Budgets (spec): at most 60k triangles in total, counting every node that
 * draws a mesh and every GPU instance; lighting baked into one lightmap of at
 * most 4096 px, read through TEXCOORD_1 (three.js: `material.lightMap` with
 * `texture.channel = 1`). The lightmap is either arena_lightmap.ktx2 next to
 * the glb or a texture the glb reads through TEXCOORD_1.
 *
 * Anchors: the game places its fires, crowd and floodlights, and checks the
 * ring edges, from named empties (apps/web/src/game/view/arena/layout.ts
 * anchorsFromScene). `ringedge_L` / `ringedge_R` must exist at x = -10 / +10
 * (the sim decides ring-outs there); a missing fire, crowd or flood group only
 * falls back to the procedural layout, so it is a warning.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Document, Node } from "@gltf-transform/core";
import type { InstancedMesh } from "@gltf-transform/extensions";
import { getGLPrimitiveCount } from "@gltf-transform/functions";
import validator from "gltf-validator";
import { ARENA_GLB, CONTRACT, fromRepo, readGlb, sha256, toRepo, type Contract } from "./gltf";
import { imageInfo, isPowerOfTwo } from "./images";
import { checkDocumentTextures } from "./textures";
import { ALLOWED_EXTENSIONS, type Issue, type ValidateReport } from "./validate";

/** GPU instancing is fine for an arena (three's GLTFLoader builds InstancedMesh from it). */
const ARENA_EXTENSIONS = [...ALLOWED_EXTENSIONS, "EXT_mesh_gpu_instancing"];

/** Ring-out edge in game units (moves.json ringEdge = 10000 mu; layout.ts RING_EDGE). */
export const RING_EDGE = 10;
/** How far a ringedge_* empty may sit from ±RING_EDGE (layout.ts checkRingEdges). */
export const RING_EDGE_TOLERANCE = 0.05;

/** How many times a node draws its mesh: its GPU instance count, else 1. */
function instances(n: Node): number {
  const ext = n.getExtension<InstancedMesh>("EXT_mesh_gpu_instancing");
  return ext?.listAttributes()[0]?.getCount() ?? 1;
}

/** A node name as three's GLTFLoader hands it to anchorsFromScene (PropertyBinding.sanitizeNodeName). */
const sanitize = (name: string) => name.replace(/\s/g, "_").replace(/[[\].:/]/g, "");

/** The anchor empties anchorsFromScene reads: ring edges (errors), fire / crowd / flood groups (warnings). */
export function checkArenaAnchors(doc: Document): Issue[] {
  const issues: Issue[] = [];
  const err = (message: string) => issues.push({ severity: "error", code: "anchors", message });
  const warn = (message: string) => issues.push({ severity: "warning", code: "anchors", message });
  const byName = new Map<string, Node>();
  for (const n of doc.getRoot().listNodes()) if (n.getName()) byName.set(sanitize(n.getName()), n);
  const names = [...byName.keys()].sort();

  for (const [name, x] of [
    ["ringedge_L", -RING_EDGE],
    ["ringedge_R", RING_EDGE],
  ] as const) {
    const node = byName.get(name);
    if (!node) {
      err(`no empty named ${name}: add one at x = ${x} (the ring edge; the game would silently assume it, and the sim rings fighters out there)`);
      continue;
    }
    const at = node.getWorldTranslation()[0];
    if (Math.abs(at - x) > RING_EDGE_TOLERANCE) err(`${name} is at x = ${at.toFixed(3)}; it must be at x = ${x} (±${RING_EDGE_TOLERANCE}), where the sim rings fighters out`);
  }

  for (const side of ["L", "R"]) {
    if (!names.some((n) => n.startsWith(`fire_${side}`))) warn(`no fire_${side}* empties (one per oil drum): the ${side === "L" ? "left" : "right"} fire cluster falls back to the procedural drums`);
  }

  const crowd = names.filter((n) => /^crowd_\d+_a$/.test(n));
  for (const a of crowd) {
    const b = a.replace(/_a$/, "_b");
    if (!byName.has(b)) warn(`${a} has no ${b}: that crowd row is skipped`);
    const count = byName.get(a)!.getExtras()["count"];
    if (count !== undefined && !(typeof count === "number" && Number.isFinite(count) && count > 0)) {
      warn(`${a} has count = ${JSON.stringify(count)}; it must be a positive number (the row uses 30)`);
    }
  }
  if (!crowd.some((a) => byName.has(a.replace(/_a$/, "_b")))) warn("no crowd_<n>_a / crowd_<n>_b pairs: the crowd falls back to the procedural bleachers");

  const floods = names.filter((n) => /^flood_\d+$/.test(n));
  for (const f of floods) if (!byName.has(`${f}_target`)) warn(`${f} has no ${f}_target: that floodlight is skipped`);
  if (!floods.some((f) => byName.has(`${f}_target`))) warn("no flood_<n> / flood_<n>_target pairs: the floodlights fall back to the procedural towers");
  return issues;
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
  issues.push(...checkArenaAnchors(doc));
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

/**
 * The arena step of `pnpm assets:validate`: the arena at `path` (default
 * apps/web/public/models/arena.glb) with arena_lightmap.ktx2 next to it, or a
 * skip when there is no such file. It runs on every validate, not only with
 * --arena, so CI checks an arena as soon as one is committed.
 */
export async function validateArenaIfPresent(path: string = fromRepo(ARENA_GLB)): Promise<{ report: ValidateReport } | { skipped: string }> {
  if (!existsSync(path)) return { skipped: `arena: no ${toRepo(path)} (the procedural junkyard needs no files); arena rules skipped` };
  return { report: await validateArenaFile(path, join(dirname(path), "arena_lightmap.ktx2")) };
}
