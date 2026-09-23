import {
  BoxGeometry, Color, CylinderGeometry, Matrix4, Mesh, Object3D, ShaderMaterial, TorusGeometry, Vector3, type BufferGeometry,
} from "three";
import { faceted, GeoBuilder, type Shade } from "./builder";
import { BEACONS, BLEACH, CHASM_FAR, PIT_BACK, type ArenaAnchors, type FireCluster, type Vec3Like } from "./layout";
import { bakeStatic, LIGHT_GLSL, OUTPUT_GLSL, withFog, type ArenaUniforms } from "./lighting";
import { fbm3, noise3, rng, smoothstep } from "./rng";

type Attr = "color" | "aLight" | "aFire";
type B = GeoBuilder<Attr>;
/** Anchors plus the string-light bulbs, whose warm light is baked into everything nearby. */
type Bake = ArenaAnchors & { bulbs: readonly Vec3Like[] };

const VERT = /* glsl */ `
attribute vec3 aLight;
attribute vec2 aFire;
varying vec3 vColor;
varying vec3 vLight;
varying vec2 vFire;
varying vec3 vWorld;
varying vec3 vNormal;
#include <fog_pars_vertex>
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vColor = color;
  vLight = aLight;
  vFire = aFire;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

/**
 * Baked props: albedo x AO in `color`, ambient + floodlight irradiance in
 * `aLight` (HDR, so lamp faces glow), per-pixel fire light on top, and `aFire`
 * marks hot drum rims / coals that glow with their cluster's flicker.
 */
const FRAG = /* glsl */ `
uniform vec2 uFlick;
varying vec3 vColor;
varying vec3 vLight;
varying vec2 vFire;
varying vec3 vWorld;
varying vec3 vNormal;
${LIGHT_GLSL}
#include <fog_pars_fragment>
const vec3 EMBER = vec3(3.2, 1.05, 0.22);
void main() {
  vec3 n = normalize(vNormal);
  vec3 col = vColor * (vLight + fireLight(vWorld, n));
  col += (vFire.x * uFlick.x + vFire.y * uFlick.y) * EMBER;
  gl_FragColor = vec4(col, 1.0);
  ${OUTPUT_GLSL}
}`;

const lin = (hex: number) => new Color(hex);
const PAINTS = [0x7a2a22, 0x2c4a6e, 0x2f5d58, 0xb8ab8a, 0xa88a2a, 0x26282a, 0x8e8e8a, 0x3c4f2c, 0x8a4a1c, 0x5a2a4a, 0x6a6f74].map(lin);
const RUST_A = lin(0x5a2410);
const RUST_B = lin(0x2e1a10);
const GLASS = lin(0x0c1014);
const CHROME = lin(0x5c6066);
const RUBBER = lin(0x141312);
const STEEL = lin(0x3a3c40);
const WOOD = lin(0x4a4038);
const BULB = new Color(1.0, 0.6, 0.28);
/** Per-bulb intensity for the baked string-light glow. */
const BULB_I = 0.3;

// Scratch objects (build time only).
const M = new Matrix4();
const M2 = new Matrix4();
const obj = new Object3D();
const tmp = new Color();
const rustTmp = new Color();

/** A transform from position / Euler / scale. */
function tf(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1): Matrix4 {
  obj.position.set(x, y, z);
  obj.rotation.set(rx, ry, rz, "YXZ");
  obj.scale.set(sx, sy, sz);
  obj.updateMatrix();
  return obj.matrix.clone();
}

interface ShadeOpts {
  albedo: (p: Vector3, n: Vector3, out: Color) => void;
  /** World y where AO starts (the object's base) and how tall the dark band is. */
  base: number;
  aoH: number;
  aoMin?: number;
  fire?: (p: Vector3, n: Vector3, out: Float32Array) => void;
}

/** Warm light from the string-light bulbs (static, so baked). */
function bakeBulbs(p: Vector3, n: Vector3, bulbs: readonly Vec3Like[], out: Float32Array): void {
  for (const q of bulbs) {
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const dz = q.z - p.z;
    const r2 = dx * dx + dy * dy + dz * dz;
    if (r2 > 16) continue;
    const ndl = Math.max(0, (n.x * dx + n.y * dy + n.z * dz) / Math.sqrt(r2 + 1e-6)) * 0.8 + 0.2;
    const e = (BULB_I * ndl) / (0.25 + r2 * 2.5);
    out[0] = (out[0] as number) + BULB.r * e;
    out[1] = (out[1] as number) + BULB.g * e;
    out[2] = (out[2] as number) + BULB.b * e;
  }
}

function shader(a: Bake, o: ShadeOpts): Shade<Attr> {
  const aoMin = o.aoMin ?? 0.35;
  return (p, n, out) => {
    o.albedo(p, n, tmp);
    // AO: dark where things meet whatever they rest on, a little darker facing down.
    const ao = (aoMin + (1 - aoMin) * smoothstep(0, o.aoH, p.y - o.base)) * (n.y < -0.5 ? 0.6 : 1);
    out.color[0] = tmp.r * ao;
    out.color[1] = tmp.g * ao;
    out.color[2] = tmp.b * ao;
    bakeStatic(p, n, a, out.aLight);
    bakeBulbs(p, n, a.bulbs, out.aLight);
    o.fire?.(p, n, out.aFire);
  };
}

/** Paint with rust creeping in from below and in patches. */
function rusty(paint: Color, rustBias: number, baseY: number) {
  return (p: Vector3, _n: Vector3, out: Color) => {
    const r = smoothstep(0.42, 0.72, fbm3(p.x * 1.3, p.y * 1.9, p.z * 1.3) + rustBias - (p.y - baseY) * 0.12);
    const grime = 0.75 + 0.45 * noise3(p.x * 4.1, p.y * 4.1, p.z * 4.1);
    out.copy(paint).lerp(rustTmp.copy(RUST_A).lerp(RUST_B, noise3(p.x * 2.3 + 5, p.y * 2.3, p.z * 2.3)), r).multiplyScalar(grime);
  };
}

const flat = (c: Color, vary = 0.25) => (p: Vector3, _n: Vector3, out: Color) => {
  out.copy(c).multiplyScalar(1 - vary / 2 + vary * noise3(p.x * 3.3, p.y * 3.3, p.z * 3.3));
};

/** Shared primitive shapes (unit-ish, transformed per copy). */
function primitives() {
  const box = faceted(new BoxGeometry(1, 1, 1));
  const box3 = faceted(new BoxGeometry(1, 1, 1, 3, 1, 1)); // long car bodies catch more of the baked gradients
  // A 4-sided cylinder rotated 45 degrees is a square frustum: the crushed cabin.
  const cabin = faceted(new CylinderGeometry(Math.SQRT1_2 * 0.72, Math.SQRT1_2, 1, 4, 1).rotateY(Math.PI / 4));
  const wheel = new CylinderGeometry(1, 1, 1, 8, 1).rotateX(Math.PI / 2); // axis along z
  const tire = new TorusGeometry(0.34, 0.14, 5, 12).rotateX(Math.PI / 2);
  const drum = new CylinderGeometry(0.3, 0.3, 0.88, 14, 2);
  const rib = new TorusGeometry(0.302, 0.02, 3, 14).rotateX(Math.PI / 2);
  const rim = new TorusGeometry(0.285, 0.035, 4, 14).rotateX(Math.PI / 2);
  return { box, box3, cabin, wheel, tire, drum, rib, rim };
}
type Prims = ReturnType<typeof primitives>;

/**
 * One crushed car. `base` is its world transform (long axis = local x,
 * resting on local y = 0). Returns its height so stacks can sit on it.
 */
function addCar(b: B, a: Bake, P: Prims, base: Matrix4, rand: () => number): number {
  const crush = 0.62 + rand() * 0.3;
  const L = 3.9 + rand() * 0.6;
  const W = 1.7 + rand() * 0.15;
  const wheelR = 0.3;
  const hasWheels = rand() < 0.55;
  const bodyY = hasWheels ? wheelR * 0.75 : 0;
  const bodyH = 0.55 * crush + 0.08;
  const cabH = 0.45 * crush * crush;
  const paint = PAINTS[Math.floor(rand() * PAINTS.length)] as Color;
  const baseY = new Vector3().setFromMatrixPosition(base).y;
  const rustBias = rand() * 0.35 - 0.05;
  const bodyShade = shader(a, { albedo: rusty(paint, rustBias, baseY), base: baseY, aoH: bodyY + bodyH + 0.2, aoMin: 0.3 });
  const glassShade = shader(a, {
    albedo: (p, n, out) => (Math.abs(n.y) < 0.6 ? out.copy(GLASS) : rusty(paint, rustBias + 0.1, baseY)(p, n, out)),
    base: baseY,
    aoH: bodyY + bodyH + cabH,
  });
  const at = (m: Matrix4) => M2.multiplyMatrices(base, m);
  b.add(P.box3, at(tf(0, bodyY + bodyH / 2, 0, 0, 0, 0, L, bodyH, W)), bodyShade);
  b.add(P.cabin, at(tf(-0.15 + (rand() - 0.5) * 0.3, bodyY + bodyH + cabH / 2, 0, 0, 0, (rand() - 0.5) * 0.08, 2.0, cabH, W * 0.9)), glassShade);
  const chromeShade = shader(a, { albedo: flat(CHROME, 0.5), base: baseY, aoH: 0.6 });
  for (const s of [-1, 1]) b.add(P.box, at(tf(s * (L / 2 + 0.05), bodyY + 0.14, 0, 0, 0, 0, 0.12, 0.16, W * 0.94)), chromeShade);
  if (hasWheels) {
    const rubber = shader(a, { albedo: flat(RUBBER, 0.3), base: baseY, aoH: 0.5, aoMin: 0.5 });
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.add(P.wheel, at(tf(sx * L * 0.32, wheelR, sz * (W / 2 - 0.08), 0, 0, 0, wheelR, wheelR, 0.24)), rubber);
  }
  return bodyY + bodyH + cabH * 0.7;
}

/** A wall of stacked cars along a line (long axis along the line). */
function carWall(
  b: B, a: Bake, P: Prims, rand: () => number,
  opts: { from: number; to: number; rows: number; place: (s: number, y: number, row: number) => Matrix4 },
): void {
  let heights: { s0: number; s1: number; h: number }[] = [];
  for (let row = 0; row < opts.rows; row++) {
    const next: { s0: number; s1: number; h: number }[] = [];
    let s = opts.from + (row % 2 ? 1.8 : 0) + rand() * 0.6;
    while (s < opts.to) {
      const len = 4.3;
      const mid = s + len / 2;
      // Rest on the tallest car below this span (upper rows are sparser, so the top is ragged).
      let y = 0;
      for (const c of heights) if (c.s1 > s + 0.4 && c.s0 < s + len - 0.4) y = Math.max(y, c.h);
      const skip = row > 0 && (y === 0 || rand() < (row === 1 ? 0.12 : 0.45));
      if (!skip) {
        const h = addCar(b, a, P, opts.place(mid, y, row), rand);
        next.push({ s0: s, s1: s + len, h: y + h * 0.96 });
      }
      s += len + 0.15 + rand() * 0.5;
    }
    heights = heights.concat(next);
  }
}

function tireStack(b: B, a: Bake, P: Prims, x: number, z: number, count: number, rand: () => number): void {
  const sh = shader(a, { albedo: flat(RUBBER, 0.4), base: 0, aoH: 0.7, aoMin: 0.45 });
  for (let i = 0; i < count; i++) {
    b.add(P.tire, tf(x + (rand() - 0.5) * 0.08, 0.14 + i * 0.27, z + (rand() - 0.5) * 0.08, (rand() - 0.5) * 0.08, rand() * 6, (rand() - 0.5) * 0.08), sh);
  }
}

function drums(b: B, a: Bake, P: Prims, cluster: FireCluster, side: 0 | 1, rand: () => number): void {
  const paints = [lin(0x1c2a3a), lin(0x3a1a14), lin(0x22301c), lin(0x2c2820)];
  for (const d of cluster.drums) {
    const paint = paints[Math.floor(rand() * paints.length)] as Color;
    // Hot coals on the top face, a heat blush on the upper wall.
    const fire = (p: Vector3, n: Vector3, out: Float32Array) => {
      const w = n.y > 0.9 && p.y > d.y + 0.8 ? 1.6 : 0.1 * smoothstep(d.y + 0.7, d.y + 0.88, p.y);
      out[side] = w;
    };
    const body = shader(a, { albedo: rusty(paint, 0.25, d.y), base: d.y, aoH: 0.5, fire });
    const yaw = rand() * 6;
    b.add(P.drum, tf(d.x, d.y + 0.44, d.z, 0, yaw), body);
    const ribShade = shader(a, { albedo: rusty(paint, 0.4, d.y), base: d.y, aoH: 0.5 });
    b.add(P.rib, tf(d.x, d.y + 0.29, d.z), ribShade);
    b.add(P.rib, tf(d.x, d.y + 0.59, d.z), ribShade);
    const rimShade = shader(a, {
      albedo: flat(lin(0x3a2418)),
      base: d.y,
      aoH: 0.1,
      fire: (_p, _n, out) => {
        out[side] = 0.32;
      },
    });
    b.add(P.rim, tf(d.x, d.y + 0.88, d.z), rimShade);
    // Burn holes punched in the side, glowing with the fire inside (camera side only).
    const hole = shader(a, {
      albedo: flat(lin(0x050302)),
      base: d.y,
      aoH: 0.1,
      fire: (_p, _n, out) => {
        out[side] = 1.15;
      },
    });
    for (let k = 0; k < 5; k++) {
      const ang = (rand() - 0.5) * 2.4;
      const hy = 0.12 + rand() * 0.55;
      b.add(P.box, tf(d.x + Math.sin(ang) * 0.3, d.y + hy, d.z + Math.cos(ang) * 0.3, 0, ang, 0, 0.045 + rand() * 0.04, 0.03 + rand() * 0.03, 0.02), hole);
    }
  }
}

function bleachers(b: B, a: Bake, P: Prims): void {
  const seat = shader(a, {
    albedo: (p, n, out) => {
      out.copy(n.y > 0.5 ? WOOD : STEEL).multiplyScalar(0.7 + 0.5 * noise3(p.x * 0.9, p.y * 2, p.z * 2));
    },
    base: 0,
    aoH: 2.5,
    aoMin: 0.5,
  });
  for (let i = 0; i < BLEACH.rows; i++) {
    const top = BLEACH.y0 + BLEACH.dy * i;
    const z = BLEACH.z0 + BLEACH.dz * i;
    b.add(P.box, tf(0, top / 2, z, 0, 0, 0, BLEACH.halfW * 2, top, -BLEACH.dz), seat);
  }
  // Scaffold poles at the ends and a rail along the front row.
  const steel = shader(a, { albedo: flat(STEEL, 0.4), base: 0, aoH: 1.5 });
  const lastTop = BLEACH.y0 + BLEACH.dy * (BLEACH.rows - 1);
  const lastZ = BLEACH.z0 + BLEACH.dz * (BLEACH.rows - 1);
  for (const s of [-1, 1]) {
    for (let i = 0; i < BLEACH.rows; i += 2) {
      const z = BLEACH.z0 + BLEACH.dz * i;
      const top = BLEACH.y0 + BLEACH.dy * i + 1.1;
      b.add(P.box, tf(s * (BLEACH.halfW + 0.1), top / 2, z, 0, 0, 0, 0.12, top, 0.12), steel);
    }
    // Hand rail along the slope at each end: rotating about x by +a lowers the box's +z end.
    const slope = Math.atan2(lastTop - BLEACH.y0, BLEACH.z0 - lastZ);
    const railLen = Math.hypot(lastTop - BLEACH.y0, lastZ - BLEACH.z0) + 1;
    b.add(P.box, tf(s * (BLEACH.halfW + 0.1), (BLEACH.y0 + lastTop) / 2 + 1.1, (BLEACH.z0 + lastZ) / 2, slope, 0, 0, 0.1, 0.1, railLen), steel);
  }
  for (let x = -BLEACH.halfW; x <= BLEACH.halfW + 0.01; x += 2.375) {
    b.add(P.box, tf(x, BLEACH.y0 + 0.45, BLEACH.z0 + 0.45, 0, 0, 0, 0.06, 0.9, 0.06), steel);
  }
  b.add(P.box, tf(0, BLEACH.y0 + 0.9, BLEACH.z0 + 0.45, 0, 0, 0, BLEACH.halfW * 2, 0.06, 0.06), steel);
}

/** Lattice mast + lamp bank aimed at the beam target. Lamp faces are HDR in aLight so they glow. */
function floodTower(b: B, a: Bake, P: Prims, i: number): void {
  const f = a.floods[i];
  if (!f) return;
  const steel = shader(a, { albedo: flat(STEEL, 0.5), base: 0, aoH: 2 });
  const legs = 0.35;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.add(P.box, tf(f.pos.x + sx * legs, (f.pos.y - 0.6) / 2, f.pos.z + sz * legs - 0.5, 0, 0, 0, 0.09, f.pos.y - 0.6, 0.09), steel);
  // Zig-zag bracing between the legs (a box's long axis is y; tilt it across the bay).
  const tilt = Math.atan2(legs * 2, 1.4);
  const len = Math.hypot(1.4, legs * 2);
  for (let y = 1.2, k = 1; y < f.pos.y - 1; y += 1.4, k = -k) {
    for (const sz of [-1, 1]) b.add(P.box, tf(f.pos.x, y + 0.7, f.pos.z + sz * legs - 0.5, 0, 0, -tilt * k, 0.05, len, 0.05), steel);
    for (const sx of [-1, 1]) b.add(P.box, tf(f.pos.x + sx * legs, y + 0.7, f.pos.z - 0.5, tilt * k, 0, 0, 0.05, len, 0.05), steel);
  }
  // Lamp bank faces the target.
  obj.position.set(f.pos.x, f.pos.y, f.pos.z);
  obj.lookAt(f.target.x, f.target.y, f.target.z);
  obj.scale.set(1, 1, 1);
  obj.updateMatrix();
  const bank = obj.matrix.clone();
  b.add(P.box, M.multiplyMatrices(bank, tf(0, 0, -0.12, 0, 0, 0, 2.2, 1.35, 0.22)), steel);
  const lamp: Shade<Attr> = (_p, _n, out) => {
    out.color[0] = 1;
    out.color[1] = 1;
    out.color[2] = 1;
    out.aLight[0] = 7.5;
    out.aLight[1] = 8.2;
    out.aLight[2] = 9.5;
  };
  for (let r = 0; r < 2; r++) for (let c = 0; c < 3; c++) b.add(P.box, M.multiplyMatrices(bank, tf((c - 1) * 0.68, (r - 0.5) * 0.6, 0.02, 0, 0, 0, 0.56, 0.46, 0.06)), lamp);
}

/** Bulbs on sagging wires between poles along the top of the back car wall. */
export function bulbPositions(): Vec3Like[] {
  const poles = [-16, -6.5, 3, 12.5];
  const out: Vec3Like[] = [];
  for (let i = 0; i + 1 < poles.length; i++) {
    const x0 = poles[i] as number;
    const x1 = poles[i + 1] as number;
    const n = Math.round((x1 - x0) / 0.75);
    for (let k = 1; k < n; k++) {
      const t = k / n;
      out.push({ x: x0 + (x1 - x0) * t, y: 4.15 - 0.75 * Math.sin(Math.PI * t), z: -9.2 + 0.25 * Math.sin(Math.PI * t) });
    }
  }
  return out;
}

function stringLights(b: B, a: Bake, P: Prims): void {
  const steel = shader(a, { albedo: flat(STEEL, 0.4), base: 0, aoH: 1 });
  for (const x of [-16, -6.5, 3, 12.5]) b.add(P.box, tf(x, 2.1, -9.2, 0, 0, 0, 0.08, 4.2, 0.08), steel);
  const wire = shader(a, { albedo: flat(lin(0x101010)), base: 0, aoH: 0.1 });
  const pts = a.bulbs;
  for (let i = 0; i + 1 < pts.length; i++) {
    const p = pts[i] as Vec3Like;
    const q = pts[i + 1] as Vec3Like;
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    if (dx > 1.2) continue; // gap at a pole
    const len = Math.hypot(dx, dy);
    b.add(P.box, tf((p.x + q.x) / 2, (p.y + q.y) / 2 + 0.06, (p.z + q.z) / 2, 0, 0, Math.atan2(dy, dx), len, 0.02, 0.02), wire);
  }
}

/** Scrap piled against the walls: crates, engine blocks, sheet metal. */
function junk(b: B, a: Bake, P: Prims, rand: () => number): void {
  const spots = [
    [-11.2, -6.9], [-10.4, -7.0], [-3.9, -7.0], [-2.1, -7.05], [1.4, -7.0], [3.2, -6.95], [10.5, -6.9], [11.4, -6.7],
    [13.0, -4.6], [-13.1, -3.8], [13.2, 1.5], [-13.0, 3.0],
  ] as const;
  for (const [x, z] of spots) {
    const n = 1 + Math.floor(rand() * 3);
    let y = 0;
    for (let i = 0; i < n; i++) {
      const w = 0.35 + rand() * 0.6;
      const h = 0.2 + rand() * 0.45;
      const d = 0.3 + rand() * 0.5;
      const paint = PAINTS[Math.floor(rand() * PAINTS.length)] as Color;
      const sh = shader(a, { albedo: rusty(paint, 0.35, 0), base: 0, aoH: 0.6 });
      b.add(P.box, tf(x + (rand() - 0.5) * 0.3, y + h / 2, z + (rand() - 0.5) * 0.3, (rand() - 0.5) * 0.15, rand() * 3, (rand() - 0.5) * 0.15, w, h, d), sh);
      y += h * 0.95;
    }
  }
  // Corrugated sheets leaning on the car wall.
  for (const x of [-9.8, -5.6, 0.2, 5.8, 9.6]) {
    const paint = PAINTS[Math.floor(rand() * PAINTS.length)] as Color;
    const sh = shader(a, { albedo: rusty(paint, 0.45, 0), base: 0, aoH: 1.2 });
    const h = 1.2 + rand() * 0.8;
    b.add(P.box, tf(x + (rand() - 0.5), h / 2 * 0.95, PIT_BACK - 0.05, -0.28 - rand() * 0.1, (rand() - 0.5) * 0.3, 0, 0.9 + rand() * 0.6, h, 0.03), sh);
  }
}

export interface Props {
  mesh: Mesh<BufferGeometry, ShaderMaterial>;
  triangles: number;
  bulbs: readonly Vec3Like[];
}

export function buildProps(u: ArenaUniforms, anchors: ArenaAnchors, seed = 1337): Props {
  const b: B = new GeoBuilder({ color: 3, aLight: 3, aFire: 2 });
  const a: Bake = { ...anchors, bulbs: bulbPositions() };
  const P = primitives();
  const rand = rng(seed);

  // Back wall: three rows of crushed cars along x, fronts at the back of the pit.
  carWall(b, a, P, rand, {
    from: -24,
    to: 22,
    rows: 3,
    place: (s, y, row) => tf(s, y, PIT_BACK - 0.95 - rand() * 0.25 - row * 0.12, 0, (rand() - 0.5) * 0.12 + (rand() < 0.5 ? Math.PI : 0), (rand() - 0.5) * 0.05),
  });
  // End walls beyond the drop-off, long axis along z.
  for (const side of [-1, 1]) {
    carWall(b, a, P, rand, {
      from: PIT_BACK - 1,
      to: 14,
      rows: 3,
      place: (s, y, row) => tf(side * (CHASM_FAR + 1.35 + row * 0.18 + rand() * 0.2), y, s, (rand() - 0.5) * 0.05, Math.PI / 2 + (rand() - 0.5) * 0.14 + (rand() < 0.5 ? Math.PI : 0)),
    });
  }
  // Tire stacks in the corners and along the walls.
  const tires: [number, number, number][] = [
    [-9.25, -6.7, 4], [-8.55, -7.0, 2], [-4.8, -6.85, 3], [4.6, -6.9, 5], [9.15, -6.75, 3], [8.5, -7.05, 2],
    [-13.3, -1.5, 3], [13.4, -2.4, 4], [-13.6, 6, 2], [13.5, 7.5, 3],
  ];
  for (const [x, z, n] of tires) tireStack(b, a, P, x, z, n, rand);
  drums(b, a, P, a.fires[0], 0, rand);
  drums(b, a, P, a.fires[1], 1, rand);
  bleachers(b, a, P);
  for (let i = 0; i < a.floods.length; i++) floodTower(b, a, P, i);
  junk(b, a, P, rand);
  stringLights(b, a, P);
  // Beacon posts: a hazard-yellow pole and an amber lamp housing (the light itself is a flare in beams.ts).
  const pole = shader(a, { albedo: flat(lin(0x6a5410), 0.4), base: 0, aoH: 0.4 });
  const housing = shader(a, { albedo: flat(lin(0x3a2a10)), base: 0, aoH: 0.1 });
  for (const q of BEACONS) {
    b.add(P.box, tf(q.x, (q.y - 0.1) / 2, q.z, 0, 0, 0, 0.07, q.y - 0.1, 0.07), pole);
    b.add(P.box, tf(q.x, q.y + 0.02, q.z, 0, 0, 0, 0.16, 0.16, 0.16), housing);
  }

  for (const g of Object.values(P)) g.dispose();
  const geo = b.build();
  const mat = new ShaderMaterial({
    name: "arena-props",
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: withFog(u),
    defines: { FLOODS: Math.max(1, a.floods.length) },
    vertexColors: true,
    fog: true,
  });
  const mesh = new Mesh(geo, mat);
  mesh.name = "arena-props";
  return { mesh, triangles: b.triangleCount, bulbs: a.bulbs };
}
