/**
 * assets:validate v1: checks a chicken glb against chicken.contract.json so a
 * bad export fails here, with a readable hint, instead of in the game.
 *
 * Errors fail the run; warnings are printed and do not. The document rules
 * (`validateDocument`) work on an in-memory gltf-transform Document, so tests
 * can mutate a parsed glb without writing it back.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Animation, Document, Node } from "@gltf-transform/core";
import { getGLPrimitiveCount } from "@gltf-transform/functions";
import validator from "gltf-validator";
import { CONTRACT, fromRepo, readGlb, sha256, type Contract, type HitboxesFile } from "./gltf";
import { KEY_EPS, axisScale, buildRig, clipDuration, frameTime, poseWorld, tracksOf, transformPoint, type Rig, type Track } from "./sample";

export type Severity = "error" | "warning";

export interface Issue {
  severity: Severity;
  /** Short rule id, e.g. "clips", "root-motion", "helpers". */
  code: string;
  message: string;
}

export interface ValidateStats {
  bytes: number;
  sha256: string;
  triangles: number;
  joints: number;
  clips: number;
  primitives: number;
  materials: string[];
  validator: { version: string; errors: number; warnings: number };
}

export interface ValidateReport {
  file: string;
  ok: boolean;
  errors: number;
  warnings: number;
  issues: Issue[];
  stats: Partial<ValidateStats>;
}

/** What the web runtime can load (three r186 GLTFLoader + our decoders). */
export const ALLOWED_EXTENSIONS = [
  "KHR_draco_mesh_compression",
  "KHR_texture_basisu",
  "KHR_materials_emissive_strength",
  "KHR_texture_transform",
  "KHR_mesh_quantization",
];

const EPS = 1e-4;
const ROOT_MOTION_EPS = 1e-3;
const LOOP_ANGLE_DEG = 2;

// --------------------------------------------------------------------------- clip names

export function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min((prev[j] as number) + 1, (cur[j - 1] as number) + 1, (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length] as number;
}

/** Ways an exported name can be a near miss: case, `.`/space/`-` for `_`, a "-<slot>" suffix. */
function nameKeys(name: string): string[] {
  const lower = name.toLowerCase();
  const keys = [lower, lower.replace(/[ .\-]/g, "_")];
  const dash = lower.lastIndexOf("-");
  if (dash > 0) keys.push(lower.slice(0, dash).replace(/[ .\-]/g, "_"));
  return keys;
}

/**
 * The exported clip name that most plausibly was meant to be `wanted`
 * (normalized match or Levenshtein <= 2), or undefined.
 */
export function clipNameHint(wanted: string, candidates: readonly string[]): string | undefined {
  let best: { name: string; d: number } | undefined;
  for (const name of candidates) {
    const d = Math.min(...nameKeys(name).map((k) => levenshtein(k, wanted)));
    if (d <= 2 && (!best || d < best.d)) best = { name, d };
  }
  return best?.name;
}

function hintFor(found: string, wanted: string): string {
  if (/-[^-]+$/.test(found) && nameKeys(found).at(-1) === wanted) {
    return `found "${found}": an action with several slots exports as "<action>-<slot>"; keep one slot per action`;
  }
  return `found "${found}": rename its NLA track (and action) to "${wanted}"`;
}

// --------------------------------------------------------------------------- document rules

const near = (a: ArrayLike<number>, b: ArrayLike<number>, eps = EPS) => Array.from(a).every((v, i) => Math.abs(v - (b[i] as number)) <= eps);

function isIdentityTRS(n: Node): boolean {
  return near(n.getTranslation(), [0, 0, 0]) && near(n.getRotation(), [0, 0, 0, 1]) && near(n.getScale(), [1, 1, 1]);
}

function ancestors(n: Node): Node[] {
  const out: Node[] = [];
  for (let p = n.getParentNode(); p; p = p.getParentNode()) out.push(p);
  return out;
}

/** Each key's value (CUBICSPLINE tangents skipped). */
function keyValues(tr: Track): number[][] {
  const cubic = tr.interp === "CUBICSPLINE";
  const stride = cubic ? 3 * tr.size : tr.size;
  const off = cubic ? tr.size : 0;
  const out: number[][] = [];
  for (let i = 0; i < tr.input.length; i++) {
    const v: number[] = [];
    for (let j = 0; j < tr.size; j++) v.push(tr.output[i * stride + off + j] as number);
    out.push(v);
  }
  return out;
}

/**
 * Whether a STEP key that changes the value is stored a hair after its frame's
 * instant frameTime(f). three.js posed at frameTime(f) would still show the
 * previous key there, one frame late, while the bake (which snaps onto keys)
 * shows this one.
 */
function hasLateStepKey(tr: Track, values: number[][], fps: number): boolean {
  for (let k = 1; k < tr.input.length; k++) {
    const t = tr.input[k] as number;
    const at = frameTime(Math.round(t * fps), fps);
    if (t > at && t - at <= KEY_EPS && !near(values[k]!, values[k - 1]!, 1e-6)) return true;
  }
  return false;
}

function quatAngleDeg(a: number[], b: number[]): number {
  const dot = Math.min(1, Math.abs(a.reduce((s, v, i) => s + v * (b[i] as number), 0)));
  return (2 * Math.acos(dot) * 180) / Math.PI;
}

export function validateDocument(doc: Document, contract: Contract = CONTRACT): { issues: Issue[]; stats: Partial<ValidateStats> } {
  const issues: Issue[] = [];
  const err = (code: string, message: string) => issues.push({ severity: "error", code, message });
  const warn = (code: string, message: string) => issues.push({ severity: "warning", code, message });
  const root = doc.getRoot();
  const stats: Partial<ValidateStats> = {};

  // Extensions.
  const used = root.listExtensionsUsed().map((e) => e.extensionName);
  for (const e of used) if (!ALLOWED_EXTENSIONS.includes(e)) err("extensions", `extension ${e} is not supported by the web runtime`);
  if (!used.includes("KHR_draco_mesh_compression")) warn("extensions", "the mesh is not Draco-compressed (export through export_chicken())");

  // Node names: three.js renames duplicates to "name_1" and strips ". : / [ ]", so lookups by name break.
  const nodes = root.listNodes();
  const counts = new Map<string, number>();
  for (const n of nodes) counts.set(n.getName(), (counts.get(n.getName()) ?? 0) + 1);
  for (const [name, c] of counts) if (c > 1) err("names", `${c} nodes are named "${name}"; three.js would rename all but one`);
  for (const name of counts.keys()) {
    if (/[\s.:/[\]]/.test(name)) warn("names", `node "${name}" has characters three.js strips (use letters, digits and _)`);
  }
  const byName = (name: string) => nodes.filter((n) => n.getName() === name);

  // Armature.
  const rigNodes = byName(contract.rig.armature);
  const rigNode = rigNodes.length === 1 ? rigNodes[0] : undefined;
  if (!rigNode) err("rig", `expected one node named "${contract.rig.armature}" (the armature), found ${rigNodes.length}`);
  else if (!isIdentityTRS(rigNode)) err("rig", `"${contract.rig.armature}" must have identity transforms (Ctrl+A > All Transforms in Blender)`);

  // Skinned mesh, joints, triangles, materials.
  const skinned = nodes.filter((n) => n.getMesh() && n.getSkin());
  for (const n of nodes) if (n.getMesh() && !n.getSkin()) warn("mesh", `mesh node "${n.getName()}" is not skinned; it will not follow the rig`);
  if (skinned.length !== 1) err("mesh", `expected exactly one skinned mesh, found ${skinned.length}`);
  const mesh = skinned[0];
  const joints = mesh?.getSkin()?.listJoints() ?? [];
  const rootJoint = byName(contract.rig.rootBone)[0];
  if (mesh) {
    if (!isIdentityTRS(mesh)) err("mesh", `skinned mesh "${mesh.getName()}" must have identity transforms`);
    const prims = mesh.getMesh()!.listPrimitives();
    stats.primitives = prims.length;
    stats.triangles = prims.reduce((s, p) => s + (p.getMode() === 4 ? getGLPrimitiveCount(p) : 0), 0);
    stats.joints = joints.length;
    if (prims.some((p) => p.getMode() !== 4)) err("mesh", "every primitive must be a triangle list");
    if (stats.triangles > contract.budgets.chickenTriangles) {
      err("budget", `${stats.triangles} triangles exceeds the budget of ${contract.budgets.chickenTriangles}`);
    }
    if (joints.length > contract.budgets.joints) {
      err("joints", `${joints.length} joints exceeds the budget of ${contract.budgets.joints} (export_def_bones drops non-deform bones)`);
    }
    if (prims.length > contract.materials.length) warn("mesh", `${prims.length} primitives = ${prims.length} draw calls per chicken`);
    const mats = [...new Set(prims.map((p) => p.getMaterial()?.getName() ?? "(none)"))].sort();
    stats.materials = mats;
    for (const m of contract.materials) if (!mats.includes(m)) err("materials", `material slot "${m}" is missing (tiers swap materials by name)`);
    for (const m of mats) if (!contract.materials.includes(m)) err("materials", `material "${m}" is not a contract slot (${contract.materials.join(", ")})`);
    // Bind-pose bounds (mesh-local = model space, since the mesh node and Rig are identity).
    let lo = [Infinity, Infinity, Infinity];
    let hi = [-Infinity, -Infinity, -Infinity];
    for (const p of prims) {
      const pos = p.getAttribute("POSITION");
      if (!pos) continue;
      lo = lo.map((v, i) => Math.min(v, pos.getMin([0, 0, 0])[i] as number));
      hi = hi.map((v, i) => Math.max(v, pos.getMax([0, 0, 0])[i] as number));
    }
    const width = (hi[0] as number) - (lo[0] as number);
    if (!(width >= 0.5 && width <= 2)) warn("bounds", `the chicken is ${width.toFixed(2)} units wide; expected 0.5..2 (wrong units or scale?)`);
    if (Math.abs(lo[1] as number) > 0.05) warn("bounds", `the lowest vertex is at y=${(lo[1] as number).toFixed(3)}; the feet should rest on y=0`);
  }
  if (!rootJoint || !joints.includes(rootJoint)) {
    err("root", `"${contract.rig.rootBone}" must be a skin joint (mark it Deform in Blender)`);
  } else {
    const parent = rootJoint.getParentNode();
    if (parent && joints.includes(parent)) err("root", `"${contract.rig.rootBone}" must be the top joint, but its parent "${parent.getName()}" is a joint`);
    for (const j of joints) {
      if (j !== rootJoint && !ancestors(j).includes(rootJoint)) err("root", `joint "${j.getName()}" is not under "${contract.rig.rootBone}"`);
    }
  }

  // Hitbox helpers.
  const rig = buildRig(doc);
  const restWorld = poseWorld(rig, [], 0);
  const helperIdx: Record<string, number> = {};
  for (const [name, spec] of Object.entries(contract.helpers)) {
    const found = byName(name);
    if (found.length !== 1) {
      err("helpers", `expected one node "${name}" (an empty parented to bone "${spec.bone}"), found ${found.length}`);
      continue;
    }
    const n = found[0]!;
    const idx = rig.index.get(n)!;
    helperIdx[name] = idx;
    if (rigNode && !ancestors(n).includes(rigNode)) err("helpers", `"${name}" must be inside "${contract.rig.armature}"`);
    if (n.getMesh()) err("helpers", `"${name}" must be an empty, not a mesh`);
    const parent = n.getParentNode();
    if (!parent || !joints.includes(parent)) err("helpers", `"${name}" must hang off a deforming bone (a skin joint)`);
    else if (parent.getName() !== spec.bone) warn("helpers", `"${name}" hangs off "${parent.getName()}"; the contract expects "${spec.bone}"`);
    const x = n.getExtras() as Record<string, unknown>;
    const hint = "export with export_chicken() (or tick Include > Custom Properties)";
    if (x["cf_shape"] !== spec.shape) err("helpers", `"${name}" needs extras.cf_shape = "${spec.shape}" (found ${JSON.stringify(x["cf_shape"])}); ${hint}`);
    const radius = x["cf_radius"];
    if (typeof radius !== "number" || !(radius > 0)) err("helpers", `"${name}" needs a numeric extras.cf_radius > 0; ${hint}`);
    else if (Math.abs(radius - spec.radius) > EPS) warn("helpers", `"${name}" cf_radius ${radius} differs from the contract's ${spec.radius}`);
    if (spec.shape === "capsule") {
      const hh = x["cf_half_height"];
      if (typeof hh !== "number" || !(hh >= 0)) err("helpers", `"${name}" needs a numeric extras.cf_half_height >= 0; ${hint}`);
      else if (spec.halfHeight !== undefined && Math.abs(hh - spec.halfHeight) > EPS) {
        warn("helpers", `"${name}" cf_half_height ${hh} differs from the contract's ${spec.halfHeight}`);
      }
    }
    const m = restWorld[idx]!;
    const [sx, sy, sz] = [axisScale(m, 0), axisScale(m, 1), axisScale(m, 2)];
    const uneven = spec.shape === "sphere" ? Math.max(sx, sy, sz) - Math.min(sx, sy, sz) : Math.abs(sx - sz);
    if (uneven > 1e-3) err("helpers", `"${name}" is scaled unevenly (${sx.toFixed(3)}, ${sy.toFixed(3)}, ${sz.toFixed(3)}); apply its scale`);
    else if (Math.abs(sx - 1) > 1e-3 || Math.abs(sy - 1) > 1e-3) warn("helpers", `"${name}" has world scale ${sx.toFixed(3)}; sizes are scaled by it`);
  }
  for (const n of nodes) {
    if (n.getName().startsWith("hit_") && !(n.getName() in contract.helpers)) warn("helpers", `extra hit helper "${n.getName()}" is not in the contract (it is baked into hitboxes.json anyway)`);
  }

  // Clips.
  const anims = root.listAnimations();
  const names = anims.map((a) => a.getName());
  stats.clips = anims.length;
  const want = contract.clips.map((c) => c.name);
  for (const name of new Set(names)) {
    const c = names.filter((n) => n === name).length;
    if (c > 1) err("clips", `${c} clips are named "${name}"`);
  }
  const extra = [...new Set(names.filter((n) => !want.includes(n)))];
  const hinted = new Set<string>();
  for (const w of want) {
    if (names.includes(w)) continue;
    const found = clipNameHint(w, extra);
    if (found) hinted.add(found);
    err("clips", `missing clip "${w}"${found ? ` (${hintFor(found, w)})` : ""}`);
  }
  for (const e of extra) {
    if (!hinted.has(e)) err("clips", `unexpected clip "${e}" (a stray action? delete it or rename it to one of the ${want.length} contract clips)`);
  }

  const jointSet = new Set(joints);
  const helperNodes = new Set(Object.values(helperIdx).map((i) => rig.nodes[i]!));
  const byClip = new Map(anims.map((a) => [a.getName(), a] as [string, Animation]));
  for (const clip of contract.clips) {
    const anim = byClip.get(clip.name);
    if (!anim) continue;
    checkClip(anim, clip, rig, { contract, rigNode, rootJoint, jointSet, helperNodes, helperIdx }, err, warn);
  }

  // Facing: at idle sample 0 the beak must be in front of the body.
  const idle = byClip.get("idle");
  const hurtName = Object.keys(contract.helpers).find((k) => contract.helpers[k]?.shape === "capsule");
  const hitNames = Object.keys(contract.helpers).filter((k) => contract.helpers[k]?.shape === "sphere");
  if (idle && hurtName && helperIdx[hurtName] !== undefined) {
    const w = poseWorld(rig, tracksOf(rig, idle), 0);
    const bodyZ = transformPoint(w[helperIdx[hurtName]]!, [0, 0, 0])[2];
    for (const h of hitNames) {
      if (helperIdx[h] === undefined) continue;
      const z = transformPoint(w[helperIdx[h]]!, [0, 0, 0])[2];
      if (!(z > bodyZ)) err("facing", `at idle frame 0 "${h}" (z=${z.toFixed(3)}) is not in front of "${hurtName}" (z=${bodyZ.toFixed(3)}): the chicken must face +Z (Blender -Y)`);
    }
  }

  return { issues, stats };
}

interface ClipCtx {
  contract: Contract;
  rigNode: Node | undefined;
  rootJoint: Node | undefined;
  jointSet: Set<Node>;
  helperNodes: Set<Node>;
  helperIdx: Record<string, number>;
}

function checkClip(
  anim: Animation,
  clip: Contract["clips"][number],
  rig: Rig,
  ctx: ClipCtx,
  err: (code: string, message: string) => void,
  warn: (code: string, message: string) => void,
): void {
  const { contract } = ctx;
  const name = clip.name;
  const tracks = tracksOf(rig, anim);
  const starts = tracks.map((t) => t.input[0] as number);
  if (starts.some((s) => Math.abs(s) > EPS)) err("timing", `clip "${name}" does not start at t=0 (export with "slide to zero")`);
  const exact = clipDuration(anim) * contract.fps;
  if (Math.abs(exact - Math.round(exact)) > 1e-3) {
    err("timing", `clip "${name}" lasts ${exact.toFixed(3)} frames, not a whole number at ${contract.fps} fps (was the scene at 24 fps?)`);
  } else if (Math.round(exact) !== clip.frames) {
    err("timing", `clip "${name}" has ${Math.round(exact)} frames; the contract needs exactly ${clip.frames} (sim frame f = clip sample f)`);
  }
  if (tracks.some((t) => Array.from(t.input).some((s) => Math.abs(s * contract.fps - Math.round(s * contract.fps)) > 1e-3))) {
    warn("timing", `clip "${name}" has keys between frames (not sampled at ${contract.fps} fps)`);
  }

  let rootMoves = false;
  let rootTurns = false;
  const loopBad: string[] = [];
  const lateStep: string[] = [];
  const foreign = new Set<string>();
  for (const tr of tracks) {
    const node = rig.nodes[tr.node]!;
    const values = keyValues(tr);
    if (tr.interp === "STEP" && hasLateStepKey(tr, values, contract.fps)) lateStep.push(`${node.getName()}.${tr.path}`);
    if (node === ctx.rigNode) err("root-motion", `clip "${name}" animates "${node.getName()}"; only bones may move`);
    if (node === ctx.rootJoint) {
      const rest = rig.rest[tr.node]![tr.path];
      const tol = tr.path === "translation" ? ROOT_MOTION_EPS : EPS;
      const moved = values.some((v) => !near(v, rest, tol));
      if (tr.path === "translation" && moved) rootMoves = true;
      else if (moved) rootTurns = true;
    }
    if (!ctx.jointSet.has(node) && !ctx.helperNodes.has(node) && node !== ctx.rigNode) foreign.add(node.getName());
    if (clip.loop && values.length > 1) {
      const a = values[0]!;
      const b = values[values.length - 1]!;
      const off = tr.path === "rotation" ? quatAngleDeg(a, b) > LOOP_ANGLE_DEG : !near(a, b, 1e-3);
      if (off) loopBad.push(`${node.getName()}.${tr.path}`);
    }
  }
  if (rootMoves) err("root-motion", `clip "${name}" moves "${contract.rig.rootBone}" (root motion is off: the sim owns position; animate "body" instead)`);
  if (rootTurns) warn("root-motion", `clip "${name}" rotates or scales "${contract.rig.rootBone}"; prefer animating "body"`);
  if (foreign.size) warn("channels", `clip "${name}" animates non-bone nodes: ${[...foreign].join(", ")}`);
  if (loopBad.length) warn("loop", `loop clip "${name}" ends in a different pose than it starts (${loopBad.slice(0, 4).join(", ")})`);
  if (lateStep.length) {
    warn(
      "timing",
      `clip "${name}" has STEP keys stored just after their frame time (${lateStep.slice(0, 4).join(", ")}); ` +
        `three.js would show them a frame late (key f must be at exactly float32 f/${contract.fps})`,
    );
  }

  const phases = anim.getExtras()["cf_phases"];
  if (clip.phases) {
    if (phases === undefined) warn("phases", `clip "${name}" has no cf_phases extra (expected [${clip.phases.join(",")}])`);
    else if (JSON.stringify(phases) !== JSON.stringify(clip.phases)) {
      err("phases", `clip "${name}" cf_phases ${JSON.stringify(phases)} != contract [${clip.phases.join(",")}]`);
    }
    // Attacks must actually reach forward while active.
    const hurt = Object.keys(contract.helpers).find((k) => contract.helpers[k]?.shape === "capsule");
    const [s, a] = clip.phases as [number, number];
    const hurtIdx = hurt ? ctx.helperIdx[hurt] : undefined;
    if (hurtIdx !== undefined && Math.round(exact) === clip.frames) {
      for (const [h, spec] of Object.entries(contract.helpers)) {
        const hi = ctx.helperIdx[h];
        if (spec.shape !== "sphere" || hi === undefined) continue;
        for (let f = s + 1; f <= s + a; f++) {
          const w = poseWorld(rig, tracks, frameTime(f, contract.fps));
          const hz = transformPoint(w[hi]!, [0, 0, 0])[2];
          const bz = transformPoint(w[hurtIdx]!, [0, 0, 0])[2];
          if (!(hz > bz)) {
            err("active", `clip "${name}" active sample ${f}: "${h}" (z=${hz.toFixed(3)}) is not in front of "${hurt}" (z=${bz.toFixed(3)})`);
            break;
          }
        }
      }
    }
  }
}

// --------------------------------------------------------------------------- files

export interface ValidateOptions {
  /** Repo or absolute path shown in messages. */
  file: string;
  contract?: Contract;
  /** When hitboxes.json's source is this file, its sha256 must match. Null skips the check. */
  hitboxes?: HitboxesFile | null;
}

export async function validateGlb(bytes: Uint8Array, opts: ValidateOptions): Promise<ValidateReport> {
  const contract = opts.contract ?? CONTRACT;
  const issues: Issue[] = [];
  const digest = sha256(bytes);
  let stats: Partial<ValidateStats> = { bytes: bytes.length, sha256: digest };

  const report = await validator.validateBytes(bytes, { maxIssues: 0 });
  stats.validator = { version: validator.version(), errors: report.issues.numErrors, warnings: report.issues.numWarnings };
  for (const m of report.issues.messages.filter((x) => x.severity === 0).slice(0, 20)) {
    issues.push({ severity: "error", code: "gltf-validator", message: `${m.code} at ${m.pointer ?? "?"}: ${m.message}` });
  }

  let doc: Document | undefined;
  try {
    doc = await readGlb(bytes);
  } catch (e) {
    issues.push({ severity: "error", code: "parse", message: `cannot read the glb: ${(e as Error).message}` });
  }
  if (doc) {
    const r = validateDocument(doc, contract);
    issues.push(...r.issues);
    stats = { ...stats, ...r.stats };
  }

  const hb = opts.hitboxes;
  if (hb?.source?.file && resolve(fromRepo(hb.source.file)) === resolve(fromRepo(opts.file)) && hb.source.sha256 !== digest) {
    issues.push({
      severity: "error",
      code: "hitboxes",
      message: `packages/sim/data/hitboxes.json was baked from a different ${hb.source.file} (sha256 ${hb.source.sha256.slice(0, 12)}..., file is ${digest.slice(0, 12)}...): run pnpm assets:bake`,
    });
  }

  const errors = issues.filter((i) => i.severity === "error").length;
  return { file: opts.file, ok: errors === 0, errors, warnings: issues.length - errors, issues, stats };
}

export async function validateFile(path: string, opts: Omit<ValidateOptions, "file"> & { file?: string } = {}): Promise<ValidateReport> {
  return validateGlb(new Uint8Array(readFileSync(path)), { ...opts, file: opts.file ?? path });
}

/** Human-readable report, one issue per line. */
export function formatReport(r: ValidateReport): string {
  const s = r.stats;
  const lines = [`validate ${r.file}`];
  if (s.bytes !== undefined) {
    lines.push(
      `  ${(s.bytes / 1024).toFixed(0)} KB, ${s.triangles ?? "?"} tris, ${s.joints ?? "?"} joints, ${s.clips ?? "?"} clips, ` +
        `${s.materials?.length ?? "?"} materials; gltf-validator ${s.validator?.errors ?? "?"} errors, ${s.validator?.warnings ?? "?"} warnings`,
    );
  }
  for (const i of r.issues) lines.push(`  ${i.severity === "error" ? "error  " : "warning"} [${i.code}] ${i.message}`);
  lines.push(`${r.ok ? "OK" : "FAIL"}: ${r.errors} error${r.errors === 1 ? "" : "s"}, ${r.warnings} warning${r.warnings === 1 ? "" : "s"}`);
  return lines.join("\n");
}
