import {
  AdditiveBlending, DynamicDrawUsage, InstancedBufferAttribute, InstancedBufferGeometry, Mesh, NormalBlending, PlaneGeometry,
  ShaderMaterial, type Scene,
} from "three";
import type { ParticleKind } from "./fxTable";

/**
 * GPU particles: instanced quads whose motion is computed in the vertex shader
 * from spawn position/time, velocity and gravity. CPU work happens only when a
 * burst is emitted (a few ring-buffer slots are written); per frame only the
 * uTime uniform changes. Two meshes: additive (sparks, flash) and alpha-blended
 * debris (screws, feathers, dust).
 */
const KIND_ID: Record<ParticleKind, number> = { spark: 0, flash: 1, screw: 2, feather: 3, dust: 4, trail: 5 };
const ADDITIVE: ReadonlySet<ParticleKind> = new Set(["spark", "flash", "trail"]);

const VERT = /* glsl */ `
attribute vec4 aSpawn; // xyz, t0
attribute vec4 aVel;   // xyz, life
attribute vec4 aMeta;  // kind, size, seed, spin
uniform float uTime;
uniform float uGrav;
varying vec2 vUv;
varying float vKind;
varying float vLife;
varying float vSeed;
void main() {
  float age = uTime - aSpawn.w;
  vKind = aMeta.x; vSeed = aMeta.z; vUv = uv;
  if (age < 0.0 || age > aVel.w) { gl_Position = vec4(0.0, 0.0, -2.0, 1.0); vLife = 1.0; return; }
  vLife = age / aVel.w;
  vec3 v = aVel.xyz;
  vec3 p;
  float kind = aMeta.x;
  if (kind > 4.5) {
    // trail: stays where it was dropped, drifts up a touch
    p = aSpawn.xyz + v * age + vec3(0.0, 0.15 * age, 0.0);
  } else if (kind > 2.5 && kind < 3.5) {
    // feather: drag, flutter, slow fall
    float k = 3.5;
    p = aSpawn.xyz + v * (1.0 - exp(-k * age)) / k + vec3(sin(age * 7.0 + aMeta.z * 6.28) * 0.15, -0.45 * age, 0.0);
  } else if (kind > 3.5) {
    // dust: drag, rises a little
    float k = 4.0;
    p = aSpawn.xyz + v * (1.0 - exp(-k * age)) / k + vec3(0.0, 0.2 * age, 0.0);
  } else {
    p = aSpawn.xyz + v * age + 0.5 * vec3(0.0, uGrav, 0.0) * age * age;
    if (kind > 1.5 && p.y < 0.02) { p.y = 0.02 + abs(p.y) * 0.4; } // screws bounce once on the floor
  }
  vec4 mv = viewMatrix * vec4(p, 1.0);
  float size = aMeta.y;
  vec2 corner = position.xy;
  if (kind < 0.5) {
    // spark: stretch the quad along the projected velocity (a streak)
    vec3 vel = v + vec3(0.0, uGrav, 0.0) * age;
    vec2 dir = (viewMatrix * vec4(vel, 0.0)).xy;
    float len = length(dir);
    vec2 ax = len > 1e-4 ? dir / len : vec2(1.0, 0.0);
    vec2 ay = vec2(-ax.y, ax.x);
    float stretch = 1.0 + min(len * 0.06, 5.0);
    corner = ax * corner.x * size * stretch + ay * corner.y * size * (1.0 - vLife * 0.7);
  } else if (kind < 1.5) {
    corner *= size * (0.6 + vLife * 1.8);
  } else if (kind > 4.5) {
    corner *= size * (1.0 - vLife * 0.6);
  } else {
    float a = aMeta.w * age + aMeta.z * 6.28;
    corner = mat2(cos(a), -sin(a), sin(a), cos(a)) * corner * size * (kind > 3.5 ? (0.6 + vLife * 1.4) : 1.0);
  }
  mv.xy += corner;
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */ `
varying vec2 vUv;
varying float vKind;
varying float vLife;
varying float vSeed;
void main() {
  vec2 d = vUv - 0.5;
  float r = length(d) * 2.0;
  vec3 col; float a;
  if (vKind < 0.5) {            // spark: hot core, orange tail
    float core = smoothstep(1.0, 0.0, r);
    col = mix(vec3(3.0, 2.4, 1.6), vec3(2.2, 0.7, 0.15), vLife) * core;
    a = core * (1.0 - vLife);
  } else if (vKind < 1.5) {     // flash: soft white burst
    float g = smoothstep(1.0, 0.0, r);
    col = vec3(2.2, 2.0, 1.7) * g * g;
    a = g * (1.0 - vLife) * (1.0 - vLife);
  } else if (vKind < 2.5) {     // screw: small steel hex-ish chip
    float s = max(abs(d.x), abs(d.y)) * 2.0;
    if (s > 0.85) discard;
    col = mix(vec3(0.55, 0.58, 0.62), vec3(0.85), step(0.5, fract(vSeed * 13.0 + vUv.x * 2.0)));
    a = 1.0;
  } else if (vKind < 3.5) {     // feather: elongated off-white ellipse
    float e = length(vec2(d.x * 3.2, d.y * 1.1)) * 2.0;
    if (e > 1.0) discard;
    col = vec3(0.92, 0.88, 0.8) * (0.8 + 0.2 * vUv.y);
    a = 1.0 - smoothstep(0.7, 1.0, vLife);
  } else if (vKind < 4.5) {     // dust: soft brown puff
    float g = smoothstep(1.0, 0.2, r);
    col = vec3(0.35, 0.28, 0.22);
    a = g * 0.45 * (1.0 - vLife);
  } else {                      // trail: chrome's cold light streak
    float g = smoothstep(1.0, 0.0, r);
    col = vec3(0.45, 0.8, 1.9) * g;
    a = g * (1.0 - vLife);
  }
  if (a <= 0.003) discard;
  gl_FragColor = vec4(col, a);
}`;

/** Deterministic hash -> [0, 1). */
function rand(seed: number, i: number): number {
  let h = (seed ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

class Pool {
  readonly mesh: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  private readonly spawn: InstancedBufferAttribute;
  private readonly vel: InstancedBufferAttribute;
  private readonly meta: InstancedBufferAttribute;
  private next = 0;
  readonly size: number;
  private lastDeath = 0;

  constructor(size: number, additive: boolean) {
    this.size = size;
    const geo = new InstancedBufferGeometry();
    const quad = new PlaneGeometry(1, 1);
    geo.index = quad.index;
    geo.setAttribute("position", quad.getAttribute("position"));
    geo.setAttribute("uv", quad.getAttribute("uv"));
    const mk = () => new InstancedBufferAttribute(new Float32Array(size * 4), 4).setUsage(DynamicDrawUsage);
    this.spawn = mk();
    this.vel = mk();
    this.meta = mk();
    // Start every slot dead (spawned far in the past with no life).
    for (let i = 0; i < size; i++) this.spawn.setW(i, -1e6);
    geo.setAttribute("aSpawn", this.spawn);
    geo.setAttribute("aVel", this.vel);
    geo.setAttribute("aMeta", this.meta);
    geo.instanceCount = size;
    const mat = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uTime: { value: 0 }, uGrav: { value: -14 } },
      transparent: true,
      depthWrite: false,
      blending: additive ? AdditiveBlending : NormalBlending,
    });
    this.mesh = new Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 20 : 10;
  }

  emit(
    t: number,
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    life: number, kind: number, size: number, seed: number, spin: number,
  ): void {
    const i = this.next;
    this.next = (this.next + 1) % this.size;
    this.spawn.setXYZW(i, x, y, z, t);
    this.vel.setXYZW(i, vx, vy, vz, life);
    this.meta.setXYZW(i, kind, size, seed, spin);
    this.lastDeath = Math.max(this.lastDeath, t + life);
  }

  get cursor(): number {
    return this.next;
  }

  /** Upload slots [start, start+count) (wrapping), as at most two ranges per attribute. */
  flush(start: number, count: number): void {
    if (count <= 0) return;
    const n = Math.min(count, this.size);
    const first = Math.min(n, this.size - start);
    for (const a of [this.spawn, this.vel, this.meta]) {
      a.addUpdateRange(start * 4, first * 4);
      if (n > first) a.addUpdateRange(0, (n - first) * 4);
      a.needsUpdate = true;
    }
  }

  live(t: number): boolean {
    return t < this.lastDeath;
  }

  setTime(t: number): void {
    this.mesh.material.uniforms.uTime!.value = t;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.removeFromParent();
  }
}

export class Particles {
  private readonly additive = new Pool(640, true);
  private readonly debris = new Pool(320, false);
  private time = 0;
  /** Low quality: particles off except the single hit flash. */
  enabled = true;

  constructor(scene: Scene) {
    scene.add(this.additive.mesh, this.debris.mesh);
  }

  /** Advance the fx clock (seconds). Runs during hit-stop so bursts read. */
  advance(dt: number): void {
    this.time += dt;
    this.additive.setTime(this.time);
    this.debris.setTime(this.time);
  }

  /**
   * Emit `count` particles of `kind` at (x, y) in game units, flying mostly
   * along `dir` (+1 / -1 on x). `seed` makes a burst reproducible.
   */
  burst(kind: ParticleKind, count: number, x: number, y: number, dir: number, seed: number): void {
    if (!this.enabled && kind !== "flash") return;
    const k = KIND_ID[kind];
    const pool = ADDITIVE.has(kind) ? this.additive : this.debris;
    const t = this.time;
    const start = pool.cursor;
    for (let i = 0; i < count; i++) {
      const r = (j: number) => rand(seed, i * 7 + j);
      const z = (r(0) - 0.5) * 0.6;
      switch (kind) {
        case "spark": {
          const sp = 5 + r(1) * 9;
          const ang = (r(2) - 0.5) * 1.9 + 0.35;
          pool.emit(t, x, y, z, dir * Math.cos(ang) * sp, Math.sin(ang) * sp + 1.5, (r(3) - 0.5) * 3, 0.18 + r(4) * 0.3, k, 0.05 + r(5) * 0.04, r(6), 0);
          break;
        }
        case "flash":
          pool.emit(t, x, y, 0.3, 0, 0, 0, 0.12, k, 1.5, r(1), 0);
          break;
        case "screw": {
          const sp = 3 + r(1) * 4;
          pool.emit(t, x, y, z, dir * (1 + r(2) * 3), sp, (r(3) - 0.5) * 2, 0.9 + r(4) * 0.6, k, 0.09, r(5), (r(6) - 0.5) * 30);
          break;
        }
        case "feather":
          pool.emit(t, x, y + 0.2, z, dir * (1 + r(1) * 4) + (r(2) - 0.5) * 3, 1.5 + r(3) * 3, (r(4) - 0.5) * 2, 1.4 + r(5) * 1.2, k, 0.16 + r(6) * 0.08, r(1), (r(2) - 0.5) * 6);
          break;
        case "trail":
          pool.emit(t, x + (r(1) - 0.5) * 0.3, y + (r(2) - 0.5) * 0.5, z * 0.3, 0, 0, 0, 0.35 + r(3) * 0.15, k, 0.35 + r(4) * 0.2, r(5), 0);
          break;
        case "dust":
          pool.emit(t, x + (r(1) - 0.5) * 0.6, 0.05, z, (r(2) - 0.5) * 3, 0.3 + r(3) * 0.6, (r(4) - 0.5), 0.5 + r(5) * 0.4, k, 0.35 + r(6) * 0.3, r(1), (r(2) - 0.5) * 2);
          break;
      }
    }
    pool.flush(start, count);
  }

  /** Any particle still alive (debug / e2e). */
  live(): boolean {
    return this.additive.live(this.time) || this.debris.live(this.time);
  }

  /** Make every pool visible for shader prewarm (compile only traverses visible objects). */
  get meshes(): Mesh[] {
    return [this.additive.mesh, this.debris.mesh];
  }

  dispose(): void {
    this.additive.dispose();
    this.debris.dispose();
  }
}
