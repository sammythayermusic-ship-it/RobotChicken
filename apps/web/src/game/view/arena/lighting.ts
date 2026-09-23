import { Color, UniformsLib, UniformsUtils, Vector2, Vector3, type IUniform } from "three";
import { noise1 } from "../camera/noise";
import type { ArenaAnchors } from "./layout";

/**
 * The arena's light rig. Static light (a dim sky/ground ambient and the two
 * cold floodlights) is baked into vertex attributes at build time by
 * bakeStatic(); the flickering fire light is evaluated per pixel from shared
 * uniforms, so the car walls and the floor breathe with the same flicker as
 * the fighters' PointLights. All colours are linear.
 */
export const AMB_SKY = new Color(0.06, 0.07, 0.1);
export const AMB_GROUND = new Color(0.014, 0.011, 0.01);
/** Light bounced off the lit pit floor onto surfaces that face it (car wall fronts). */
export const BOUNCE = new Color(0.05, 0.04, 0.035);
export const FLOOD_COL = new Color(0.62, 0.74, 1.0).multiplyScalar(0.85);
/** Floodlight cone: cos(outer), cos(inner) half-angles. */
export const FLOOD_CONE = new Vector2(Math.cos((12 * Math.PI) / 180), Math.cos((4 * Math.PI) / 180));
export const FIRE_COL = new Color(1.0, 0.42, 0.12);
/** Surface fire intensity (arena shaders: I / (1 + d^2)). */
export const FIRE_I = 6;
/** PointLight intensity (candela, decay 2) for the fighters at peak flicker. */
export const FIRE_POINT_I = 42;

/** Uniform objects shared by every arena material (one update per frame reaches all of them). */
export interface ArenaUniforms {
  uTime: IUniform<number>;
  uHype: IUniform<number>;
  /** Flicker per fire cluster (0.6..1). */
  uFlick: IUniform<Vector2>;
  uFirePos: IUniform<Vector3[]>;
  /** FIRE_COL * FIRE_I * flicker, per cluster. */
  uFireCol: IUniform<Vector3[]>;
  uFloodPos: IUniform<Vector3[]>;
  uFloodDir: IUniform<Vector3[]>;
  uFloodCol: IUniform<Color>;
  uFloodCone: IUniform<Vector2>;
  uAmbSky: IUniform<Color>;
  uAmbGround: IUniform<Color>;
}

export function createUniforms(a: ArenaAnchors): ArenaUniforms {
  const [l, r] = a.fires;
  return {
    uTime: { value: 0 },
    uHype: { value: 0.2 },
    uFlick: { value: new Vector2(1, 1) },
    uFirePos: { value: [new Vector3(l.light.x, l.light.y, l.light.z), new Vector3(r.light.x, r.light.y, r.light.z)] },
    uFireCol: { value: [new Vector3(), new Vector3()] },
    uFloodPos: { value: a.floods.map((f) => new Vector3(f.pos.x, f.pos.y, f.pos.z)) },
    uFloodDir: {
      value: a.floods.map((f) => new Vector3(f.target.x - f.pos.x, f.target.y - f.pos.y, f.target.z - f.pos.z).normalize()),
    },
    uFloodCol: { value: FLOOD_COL.clone() },
    uFloodCone: { value: FLOOD_CONE.clone() },
    uAmbSky: { value: AMB_SKY.clone() },
    uAmbGround: { value: AMB_GROUND.clone() },
  };
}

/** Fog uniforms are per material (three writes them from scene.fog); the rest are shared by reference. */
export function withFog<T extends object>(shared: T): T & Record<string, IUniform> {
  return { ...UniformsUtils.clone(UniformsLib.fog), ...shared };
}

/**
 * Fire flicker in [~0.6, 1]: two octaves of seeded value noise. The same
 * value drives the PointLight, the surface fire light, the drum rims and the
 * flames, so every cue agrees. Deterministic in t (no Math.random).
 */
export function flicker(seed: number, t: number): number {
  return 0.8 + 0.13 * noise1(seed, t * 7.3) + 0.07 * noise1(seed + 101, t * 21.7);
}

const d = new Vector3();
const l = new Vector3();

/** Static irradiance at a surface point (ambient + floodlights), written into out[0..2]. */
export function bakeStatic(p: Vector3, n: Vector3, a: ArenaAnchors, out: Float32Array, o = 0): void {
  const up = n.y * 0.5 + 0.5;
  let r = AMB_GROUND.r + (AMB_SKY.r - AMB_GROUND.r) * up;
  let g = AMB_GROUND.g + (AMB_SKY.g - AMB_GROUND.g) * up;
  let b = AMB_GROUND.b + (AMB_SKY.b - AMB_GROUND.b) * up;
  // Bounce from the pit floor: strongest low down, on faces turned toward the pit (+z).
  const bounce = Math.max(0, n.z) * (1 - Math.min(1, Math.max(0, p.y / 5))) * (Math.abs(p.x) < 14 ? 1 : 0.5);
  r += BOUNCE.r * bounce;
  g += BOUNCE.g * bounce;
  b += BOUNCE.b * bounce;
  for (const f of a.floods) {
    l.set(f.pos.x - p.x, f.pos.y - p.y, f.pos.z - p.z).normalize();
    d.set(f.target.x - f.pos.x, f.target.y - f.pos.y, f.target.z - f.pos.z).normalize();
    const cos = -l.dot(d);
    const t = Math.min(1, Math.max(0, (cos - FLOOD_CONE.x) / (FLOOD_CONE.y - FLOOD_CONE.x)));
    const spot = t * t * (3 - 2 * t);
    const ndl = Math.max(0, n.dot(l));
    r += FLOOD_COL.r * spot * ndl;
    g += FLOOD_COL.g * spot * ndl;
    b += FLOOD_COL.b * spot * ndl;
  }
  out[o] = r;
  out[o + 1] = g;
  out[o + 2] = b;
}

/** GLSL: per-pixel fire light (2 clusters) and floodlights; must match bakeStatic / FIRE_I. */
export const LIGHT_GLSL = /* glsl */ `
uniform vec3 uFirePos[2];
uniform vec3 uFireCol[2];
uniform vec3 uFloodPos[FLOODS];
uniform vec3 uFloodDir[FLOODS];
uniform vec3 uFloodCol;
uniform vec2 uFloodCone;
uniform vec3 uAmbSky;
uniform vec3 uAmbGround;
vec3 fireLight(vec3 p, vec3 n) {
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 2; i++) {
    vec3 d = uFirePos[i] - p;
    float r2 = dot(d, d);
    // Wrapped diffuse: a fire is a big soft source, and it keeps side faces from going flat black.
    float ndl = clamp(dot(n, d) * inversesqrt(r2) * 0.75 + 0.25, 0.0, 1.0);
    acc += uFireCol[i] * ndl / (1.2 + r2);
  }
  return acc;
}
vec3 floodLight(vec3 p, vec3 n) {
  vec3 acc = vec3(0.0);
  for (int i = 0; i < FLOODS; i++) {
    vec3 l = normalize(uFloodPos[i] - p);
    float spot = smoothstep(uFloodCone.x, uFloodCone.y, dot(-l, uFloodDir[i]));
    acc += uFloodCol * spot * max(dot(n, l), 0.0);
  }
  return acc;
}
vec3 ambient(vec3 n) {
  return mix(uAmbGround, uAmbSky, n.y * 0.5 + 0.5);
}
`;

/** GLSL: cheap hash / value noise (no sin(): stable precision on mobile GPUs). */
export const NOISE_GLSL = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
`;

/** Output tail every arena shader ends with (matches the built-in materials' order). */
export const OUTPUT_GLSL = /* glsl */ `
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
`;
