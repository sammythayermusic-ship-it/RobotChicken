/**
 * glTF animation sampling and node-hierarchy evaluation, in float64, with no
 * three.js: the bake and the validator both pose a gltf-transform Document
 * through this module (three is only the independent oracle in bakeParity).
 *
 * Exporters store key times as float32: Blender writes key f at exactly
 * Math.fround(f / 60), which for most frames is slightly above the float64
 * f / 60. So sim frame f samples every clip at frameTime(f), that float32
 * instant, here and at runtime. three.js's STEP interpolant shows the last key
 * at or before t, so posing it at the float64 f / 60 would show key f - 1 on
 * those frames, a frame away from the bake. A time within KEY_EPS of a key
 * also returns that key's value unchanged, so the bake is exact on any key.
 */
import type { Animation, Document, Node } from "@gltf-transform/core";

export type Interpolation = "STEP" | "LINEAR" | "CUBICSPLINE";
export type Vec3 = [number, number, number];
/** Column-major 4x4, like glTF and three.js. */
export type Mat4 = Float64Array;

/** Seconds; far below half a frame (8.3 ms) and far above float32 time error. */
export const KEY_EPS = 1e-5;

/**
 * The clip time (seconds) at which sim frame f is sampled: the float32 time
 * an exporter stores for key f. The bake uses it, and the runtime must pose
 * with `action.time = Math.fround(f / 60)` (not f / 60) so a STEP key lands on
 * the same frame in both.
 */
export function frameTime(f: number, fps: number): number {
  return Math.fround(f / fps);
}

function normalize(v: number[]): number[] {
  const len = Math.hypot(...v);
  return len > 0 ? v.map((x) => x / len) : v;
}

function slerp(a: number[], b: number[], u: number): number[] {
  let dot = 0;
  for (let i = 0; i < 4; i++) dot += (a[i] as number) * (b[i] as number);
  const sign = dot < 0 ? -1 : 1;
  dot *= sign;
  if (dot > 0.9995) return normalize(a.map((x, i) => x + (sign * (b[i] as number) - x) * u));
  const theta = Math.acos(dot);
  const s = Math.sin(theta);
  const wa = Math.sin((1 - u) * theta) / s;
  const wb = (sign * Math.sin(u * theta)) / s;
  return a.map((x, i) => x * wa + (b[i] as number) * wb);
}

/**
 * Value of one sampler at time `t` (seconds). `size` is the element size
 * (3 or 4); `quat` marks rotation output, which is slerped (LINEAR) or
 * renormalized (CUBICSPLINE). Times outside the keys clamp to the ends.
 */
export function sampleAt(
  input: ArrayLike<number>,
  output: ArrayLike<number>,
  size: number,
  interp: Interpolation,
  t: number,
  quat: boolean,
): number[] {
  const n = input.length;
  if (n === 0) throw new Error("sampler has no keys");
  const cubic = interp === "CUBICSPLINE";
  const stride = cubic ? 3 * size : size;
  const valueOffset = cubic ? size : 0;
  const key = (i: number, off = valueOffset): number[] => {
    const out: number[] = [];
    for (let j = 0; j < size; j++) out.push(output[i * stride + off + j] as number);
    return out;
  };
  const time = (i: number) => input[i] as number;
  if (t <= time(0) + KEY_EPS) return key(0);
  if (t >= time(n - 1) - KEY_EPS) return key(n - 1);
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (time(mid) <= t) lo = mid;
    else hi = mid;
  }
  if (t - time(lo) <= KEY_EPS) return key(lo);
  if (time(hi) - t <= KEY_EPS) return key(hi);
  if (interp === "STEP") return key(lo);
  const dt = time(hi) - time(lo);
  const u = (t - time(lo)) / dt;
  if (!cubic) {
    const a = key(lo);
    const b = key(hi);
    return quat ? slerp(a, b, u) : a.map((x, j) => x + ((b[j] as number) - x) * u);
  }
  // Hermite spline: output holds [in-tangent, value, out-tangent] per key.
  const p0 = key(lo);
  const p1 = key(hi);
  const m0 = key(lo, 2 * size);
  const m1 = key(hi, 0);
  const u2 = u * u;
  const u3 = u2 * u;
  const r = p0.map(
    (x, j) =>
      (2 * u3 - 3 * u2 + 1) * x +
      (u3 - 2 * u2 + u) * dt * (m0[j] as number) +
      (-2 * u3 + 3 * u2) * (p1[j] as number) +
      (u3 - u2) * dt * (m1[j] as number),
  );
  return quat ? normalize(r) : r;
}

// --------------------------------------------------------------------------- matrices

export function compose(t: ArrayLike<number>, q: ArrayLike<number>, s: ArrayLike<number>): Mat4 {
  const [x, y, z, w] = [q[0] as number, q[1] as number, q[2] as number, q[3] as number];
  const [sx, sy, sz] = [s[0] as number, s[1] as number, s[2] as number];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return Float64Array.of(
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    t[0] as number, t[1] as number, t[2] as number, 1,
  );
}

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let v = 0;
      for (let k = 0; k < 4; k++) v += (a[k * 4 + r] as number) * (b[c * 4 + k] as number);
      out[c * 4 + r] = v;
    }
  }
  return out;
}

export function transformPoint(m: Mat4, p: ArrayLike<number>): Vec3 {
  const [x, y, z] = [p[0] as number, p[1] as number, p[2] as number];
  const e = (i: number) => m[i] as number;
  return [
    e(0) * x + e(4) * y + e(8) * z + e(12),
    e(1) * x + e(5) * y + e(9) * z + e(13),
    e(2) * x + e(6) * y + e(10) * z + e(14),
  ];
}

/** Length of basis column `c` (0 = x, 1 = y, 2 = z): the world scale along that local axis. */
export function axisScale(m: Mat4, c: number): number {
  return Math.hypot(m[c * 4] as number, m[c * 4 + 1] as number, m[c * 4 + 2] as number);
}

// --------------------------------------------------------------------------- posing

export type TargetPath = "translation" | "rotation" | "scale";

export interface Track {
  node: number;
  path: TargetPath;
  input: ArrayLike<number>;
  output: ArrayLike<number>;
  size: number;
  interp: Interpolation;
}

/** The node hierarchy with rest transforms, ready to be posed. */
export interface Rig {
  nodes: Node[];
  index: Map<Node, number>;
  /** Parent index, -1 for a scene root. */
  parent: Int32Array;
  rest: { translation: number[]; rotation: number[]; scale: number[] }[];
}

export function buildRig(doc: Document): Rig {
  const nodes = doc.getRoot().listNodes();
  const index = new Map(nodes.map((n, i) => [n, i]));
  const parent = Int32Array.from(nodes, (n) => {
    const p = n.getParentNode();
    return p ? (index.get(p) ?? -1) : -1;
  });
  const rest = nodes.map((n) => ({ translation: [...n.getTranslation()], rotation: [...n.getRotation()], scale: [...n.getScale()] }));
  return { nodes, index, parent, rest };
}

export function nodeIndex(rig: Rig, name: string): number {
  return rig.nodes.findIndex((n) => n.getName() === name);
}

/** The TRS channels of `anim` (morph-weight channels are ignored). */
export function tracksOf(rig: Rig, anim: Animation): Track[] {
  const tracks: Track[] = [];
  for (const ch of anim.listChannels()) {
    const node = ch.getTargetNode();
    const path = ch.getTargetPath();
    const sampler = ch.getSampler();
    const input = sampler?.getInput()?.getArray();
    const output = sampler?.getOutput();
    if (!node || !sampler || !input || !output || (path !== "translation" && path !== "rotation" && path !== "scale")) continue;
    const i = rig.index.get(node);
    const values = output.getArray();
    if (i === undefined || !values) continue;
    tracks.push({ node: i, path, input, output: values, size: output.getElementSize(), interp: sampler.getInterpolation() as Interpolation });
  }
  return tracks;
}

/** Clip length in seconds (last key of any sampler). */
export function clipDuration(anim: Animation): number {
  let max = 0;
  for (const s of anim.listSamplers()) {
    const input = s.getInput()?.getArray();
    if (input && input.length) max = Math.max(max, input[input.length - 1] as number);
  }
  return max;
}

/** World matrix of every node at time `t` of a clip; channels a clip lacks stay at rest (as three.js does). */
export function poseWorld(rig: Rig, tracks: readonly Track[], t: number): Mat4[] {
  const local = rig.rest.map((r) => ({ translation: r.translation, rotation: r.rotation, scale: r.scale }));
  for (const tr of tracks) {
    const v = sampleAt(tr.input, tr.output, tr.size, tr.interp, t, tr.path === "rotation");
    local[tr.node] = { ...(local[tr.node] as (typeof local)[number]), [tr.path]: v };
  }
  const world: (Mat4 | undefined)[] = new Array(rig.nodes.length);
  const resolve = (i: number): Mat4 => {
    const done = world[i];
    if (done) return done;
    const l = local[i] as (typeof local)[number];
    const m = compose(l.translation, l.rotation, l.scale);
    const p = rig.parent[i] as number;
    const w = p >= 0 ? multiply(resolve(p), m) : m;
    world[i] = w;
    return w;
  };
  return rig.nodes.map((_, i) => resolve(i));
}
