import {
  AdditiveBlending, CanvasTexture, InstancedBufferAttribute, InstancedBufferGeometry, LinearMipmapLinearFilter, Mesh, NoColorSpace, PlaneGeometry,
  ShaderMaterial, type IUniform,
} from "three";
import type { CrowdRow } from "./layout";
import { OUTPUT_GLSL, withFog } from "./lighting";
import { rng } from "./rng";

/**
 * The crowd: every robot chicken in the bleachers is one instance of a single
 * camera-facing quad (ONE draw call). A Canvas2D atlas holds 4 silhouettes
 * (2 bodies x wings down/up) as data masks: R = coverage, G = eyes,
 * B = rim (top edges catching the floodlights). The vertex shader bobs and
 * flaps them from uHype (0.2 idle .. 1 on a KO), and when the crowd is hot a
 * few instances fire camera flashes. Per frame only uniforms change.
 *
 * The hop and flap RATES follow hype, so their PHASES are integrated on the
 * CPU (advanceCrowd) and passed in as uBob / uFlap. Computing them in the
 * shader as uTime * rate(hype) would jump the phase by t * d(rate) whenever
 * hype moves: every silhouette would snap to a random wing frame after each
 * hit, worse the longer the match runs.
 */
const CELL = 256;

/** Shared by both passes: per-instance motion and the camera-flash schedule. */
const COMMON = /* glsl */ `
attribute vec3 aPos;   // feet
attribute vec4 aMeta;  // body (0/1), phase, scale, seed
uniform float uTime;
uniform float uHype;
uniform float uBob;   // hop phase, radians in [0, 2pi)
uniform float uFlap;  // wing cycle phase in [0, 1)
float h11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}
// A few of the crowd flash in 0.4 s slots, only when the crowd is hot.
float flashNow() {
  float slot = floor(uTime * 2.5 + aMeta.w * 17.0);
  float inSlot = fract(uTime * 2.5 + aMeta.w * 17.0);
  float chance = smoothstep(0.5, 1.0, uHype) * 0.08;
  return step(h11(slot * 1.37 + aMeta.w * 91.7), chance) * (1.0 - smoothstep(0.1, 0.45, inSlot));
}
// A hop whose height (here) and rate (advanceCrowd) grow with hype.
float bob() {
  float h = uHype;
  return h * h * abs(sin(uBob + aMeta.y * 6.2831)) * 0.22 * aMeta.z;
}
`;

const VERT = /* glsl */ `
${COMMON}
varying vec2 vUv;
varying vec2 vLocal;
varying float vFlash;
varying float vShade;
#include <fog_pars_vertex>
void main() {
  float h = uHype;
  float ph = aMeta.y * 6.2831;
  float scale = aMeta.z;
  // A slow sway even when bored.
  float sway = sin(uTime * (0.9 + aMeta.w) + ph * 1.7) * 0.035;
  // Wings up for a hype-driven share of a hype-driven cycle (cheering; the rate is in advanceCrowd).
  float up = step(fract(uFlap + aMeta.y * 3.1), 0.08 + 0.55 * h * h);
  float frame = aMeta.x * 2.0 + up;
  vec2 cell = vec2(mod(frame, 2.0), floor(frame * 0.5));
  vUv = (uv + cell) * 0.5;
  vLocal = uv;
  vFlash = flashNow();
  vShade = 0.6 + 0.8 * fract(aMeta.w * 13.7);
  // Cylindrical billboard: faces the camera, stays upright in the world.
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  float size = 1.1 * scale;
  vec3 wp = aPos + vec3(sway, bob(), 0.0) + right * position.x * size + vec3(0.0, (position.y + 0.5) * size, 0.0);
  vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const FRAG = /* glsl */ `
uniform sampler2D uAtlas;
uniform float uHype;
varying vec2 vUv;
varying vec2 vLocal;
varying float vFlash;
varying float vShade;
#include <fog_pars_fragment>
void main() {
  vec3 t = texture2D(uAtlas, vUv).rgb;
  if (t.r < 0.5) discard;
  vec3 col = vec3(0.004, 0.0045, 0.006) * vShade;
  col += vec3(0.045, 0.055, 0.09) * t.b;
  col += vec3(5.0, 0.3, 0.12) * t.g * (0.5 + 0.5 * uHype);
  col = mix(col, vec3(0.3, 0.31, 0.36), vFlash * 0.2); // lit by its own flash
  gl_FragColor = vec4(col, 1.0);
  ${OUTPUT_GLSL}
}`;

/**
 * Flash pass: the same instances, drawn additively as a starburst at the
 * phone held up by the head. Instances that are not flashing collapse to a
 * clipped point, so the pass costs one draw call and almost no fill.
 */
const FLASH_VERT = /* glsl */ `
${COMMON}
varying vec2 vQ;
varying float vFlash;
void main() {
  vFlash = flashNow();
  vQ = position.xy;
  if (vFlash <= 0.0) { gl_Position = vec4(0.0, 0.0, -2.0, 1.0); return; }
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  float s = 1.1 * aMeta.z;
  vec3 phone = aPos + vec3(0.15 * s, 0.72 * s + bob(), 0.12);
  gl_Position = projectionMatrix * viewMatrix * vec4(phone + (right * position.x + up * position.y) * 1.3, 1.0);
}`;

const FLASH_FRAG = /* glsl */ `
varying vec2 vQ;
varying float vFlash;
void main() {
  float r = length(vQ) * 2.0;
  float core = smoothstep(0.35, 0.0, r);
  float glow = smoothstep(1.0, 0.0, r) * 0.35;
  float rays = (smoothstep(0.05, 0.0, abs(vQ.x)) + smoothstep(0.05, 0.0, abs(vQ.y))) * smoothstep(1.0, 0.1, r);
  float a = (core + glow * glow + rays * 0.6) * vFlash;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vec3(1.2, 1.2, 1.35), a);
}`;

type Ctx = CanvasRenderingContext2D;

function ellipse(g: Ctx, x: number, y: number, rx: number, ry: number, rot = 0): void {
  g.beginPath();
  g.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2);
  g.fill();
}

function poly(g: Ctx, pts: number[]): void {
  g.beginPath();
  g.moveTo(pts[0] as number, pts[1] as number);
  for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i] as number, pts[i + 1] as number);
  g.closePath();
  g.fill();
}

function roundRect(g: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
  g.fill();
}

/** Legs and feet shared by both bodies (cell-local pixels, feet on y = 250). */
function legs(g: Ctx, spread: number, thick: number): void {
  for (const s of [-1, 1]) {
    const x = 128 + s * spread;
    g.fillRect(x - thick / 2, 196, thick, 50);
    poly(g, [x - 14, 250, x + 14, 250, x + 5, 240, x - 5, 240]);
  }
}

/** Front-facing round rooster-bot: comb, beak, wattle, two eyes. */
function rooster(g: Ctx, wingsUp: boolean, eyes: boolean): void {
  if (eyes) {
    ellipse(g, 113, 86, 7, 6);
    ellipse(g, 143, 86, 7, 6);
    return;
  }
  legs(g, 17, 8);
  ellipse(g, 128, 160, 60, 54);
  ellipse(g, 128, 90, 33, 32);
  for (const [x, y, r] of [[110, 58, 11], [128, 50, 14], [146, 58, 11]] as const) ellipse(g, x, y, r, r);
  poly(g, [117, 98, 139, 98, 128, 121]);
  ellipse(g, 128, 124, 7, 10);
  for (const s of [-1, 1]) {
    if (wingsUp) ellipse(g, 128 + s * 70, 100, 17, 46, s * 0.55);
    else ellipse(g, 128 + s * 58, 168, 18, 44, -s * 0.25);
  }
}

/** Front-facing boxy robot: square head with an antenna and a visor. */
function boxy(g: Ctx, wingsUp: boolean, eyes: boolean): void {
  if (eyes) {
    g.fillRect(104, 76, 48, 11);
    return;
  }
  legs(g, 20, 11);
  roundRect(g, 80, 122, 96, 86, 16);
  roundRect(g, 96, 58, 64, 54, 10);
  g.fillRect(126, 30, 4, 30);
  ellipse(g, 128, 28, 7, 7);
  poly(g, [118, 104, 138, 104, 128, 124]);
  for (const s of [-1, 1]) {
    if (wingsUp) {
      g.save();
      g.translate(128 + s * 58, 128);
      g.rotate(s * 0.5);
      g.fillRect(-10, -62, 20, 64);
      g.restore();
    } else {
      g.save();
      g.translate(128 + s * 56, 134);
      g.rotate(-s * 0.18);
      g.fillRect(-10, 0, 20, 62);
      g.restore();
    }
  }
}

/** Draws the 2x2 atlas (R coverage, G eyes, B rim) into a 512x512 canvas. */
export function drawCrowdAtlas(canvas: HTMLCanvasElement): void {
  canvas.width = CELL * 2;
  canvas.height = CELL * 2;
  const g = canvas.getContext("2d", { willReadFrequently: true });
  if (!g) throw new Error("crowd atlas: no 2d context");
  // Opaque black first: every texel keeps alpha 1, so the channels are pure masks.
  g.fillStyle = "#000";
  g.fillRect(0, 0, canvas.width, canvas.height);
  const draw = [rooster, boxy];
  for (let f = 0; f < 4; f++) {
    const body = draw[f >> 1] as typeof rooster;
    const up = (f & 1) === 1;
    g.save();
    // Cell (col, row) = (f % 2, f >> 1); canvas y runs down, texture v runs up (flipY).
    g.translate((f % 2) * CELL, (1 - (f >> 1)) * CELL);
    g.globalCompositeOperation = "source-over";
    g.fillStyle = "#f00";
    body(g, up, false);
    g.globalCompositeOperation = "lighter";
    g.fillStyle = "#0f0";
    body(g, up, true);
    g.restore();
  }
  // Rim mask: coverage whose neighbour a few pixels above (or beside) is empty.
  const img = g.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  const W = canvas.width;
  const R = (x: number, y: number) => (x < 0 || y < 0 || x >= W || y >= W ? 0 : (d[(y * W + x) * 4] as number) / 255);
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const c = R(x, y);
      if (c === 0) continue;
      const top = 1 - R(x, y - 4);
      d[(y * W + x) * 4 + 2] = Math.round(255 * c * top);
    }
  }
  g.putImageData(img, 0, 0);
}

/** The crowd's hop and wing-flap phases (radians, cycles). */
export interface CrowdClock {
  bob: number;
  flap: number;
}

const TAU = Math.PI * 2;
/** Hop rate (rad/s) and wing-flap rate (cycles/s) at a hype level. */
export const hopRate = (hype: number) => 3 + 7 * hype;
export const flapRate = (hype: number) => 0.35 + 3.4 * hype;

/**
 * Advance the phases by dt at the current hype's rates. Integrating keeps the
 * motion continuous when hype jumps (a KO takes it from ~0.3 to 1 in a few
 * frames), and the wrap keeps float precision flat over a long match.
 */
export function advanceCrowd(c: CrowdClock, dt: number, hype: number): void {
  c.bob = (c.bob + dt * hopRate(hype)) % TAU;
  c.flap = (c.flap + dt * flapRate(hype)) % 1;
}

export interface Crowd {
  mesh: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  /** Camera flashes: same geometry, additive. */
  flashes: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  texture: CanvasTexture;
  count: number;
  /** Per frame: advance the hop / flap phases at the current hype (writes two uniforms). */
  update(dt: number, hype: number): void;
}

export function buildCrowd(
  rows: readonly CrowdRow[],
  shared: { uTime: IUniform<number>; uHype: IUniform<number> },
  maxAnisotropy = 1,
  seed = 7,
): Crowd {
  const canvas = document.createElement("canvas");
  drawCrowdAtlas(canvas);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = NoColorSpace; // data masks, not colours
  texture.minFilter = LinearMipmapLinearFilter;
  texture.anisotropy = Math.min(4, maxAnisotropy); // the stands are seen at a grazing angle

  const rand = rng(seed);
  const pos: number[] = [];
  const meta: number[] = [];
  for (const row of rows) {
    for (let i = 0; i < row.count; i++) {
      // Jitter along the row, and a little up/down and front/back, so rows don't read as ruler lines.
      const t = (i + 0.5 + (rand() - 0.5) * 0.7) / row.count;
      pos.push(
        row.from.x + (row.to.x - row.from.x) * t,
        row.from.y + (row.to.y - row.from.y) * t + (rand() - 0.5) * 0.14,
        row.from.z + (row.to.z - row.from.z) * t + (rand() - 0.5) * 0.3,
      );
      meta.push(rand() < 0.55 ? 0 : 1, rand(), 0.8 + rand() * 0.4, rand());
    }
  }
  const count = pos.length / 3;
  const quad = new PlaneGeometry(1, 1);
  const geo = new InstancedBufferGeometry();
  geo.index = quad.index;
  geo.setAttribute("position", quad.getAttribute("position"));
  geo.setAttribute("uv", quad.getAttribute("uv"));
  geo.setAttribute("aPos", new InstancedBufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute("aMeta", new InstancedBufferAttribute(new Float32Array(meta), 4));
  geo.instanceCount = count;

  // Owned by the crowd, shared by both passes (the flash rides the hop too).
  const uBob = { value: 0 };
  const uFlap = { value: 0 };
  const clock: CrowdClock = { bob: 0, flap: 0 };
  const mat = new ShaderMaterial({
    name: "arena-crowd",
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: withFog({ uTime: shared.uTime, uHype: shared.uHype, uBob, uFlap, uAtlas: { value: texture } }),
    fog: true,
  });
  const mesh = new Mesh(geo, mat);
  mesh.name = "arena-crowd";
  mesh.frustumCulled = false; // instances span the bleachers; the base quad's bounds mean nothing
  const flashes = new Mesh(
    geo,
    new ShaderMaterial({
      name: "arena-crowd-flash",
      vertexShader: FLASH_VERT,
      fragmentShader: FLASH_FRAG,
      uniforms: { uTime: shared.uTime, uHype: shared.uHype, uBob, uFlap },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    }),
  );
  flashes.name = "arena-crowd-flash";
  flashes.frustumCulled = false;
  flashes.renderOrder = 17;
  return {
    mesh,
    flashes,
    texture,
    count,
    update(dt, hype) {
      advanceCrowd(clock, dt, hype);
      uBob.value = clock.bob;
      uFlap.value = clock.flap;
    },
  };
}
