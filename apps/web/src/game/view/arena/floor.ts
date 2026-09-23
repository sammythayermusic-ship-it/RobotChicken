import { BoxGeometry, Matrix4, Mesh, PlaneGeometry, ShaderMaterial } from "three";
import { GeoBuilder } from "./builder";
import { CHASM_DEPTH, CHASM_FAR, HAZARD_IN, LIP_H, LIP_IN, PIT_BACK, PIT_FRONT, RING_EDGE } from "./layout";
import { LIGHT_GLSL, NOISE_GLSL, OUTPUT_GLSL, withFog, type ArenaUniforms } from "./lighting";

/** Surface kinds, read by the floor shader. */
const PIT = 0;
const LIP = 1;
const CHASM = 2;
const GROUND = 3;

const VERT = /* glsl */ `
attribute float aKind;
varying vec3 vWorld;
varying vec3 vNormal;
varying float vKind;
#include <fog_pars_vertex>
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vKind = aKind;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

/**
 * Per-pixel floor: concrete slabs worn through to dirt, oil stains, a yellow /
 * black hazard band inside the lip, a striped lip exactly at the ring edge, and
 * a drop-off that falls away into black. Lit by the shared fire + flood rig.
 */
const FRAG = /* glsl */ `
varying vec3 vWorld;
varying vec3 vNormal;
varying float vKind;
${LIGHT_GLSL}
${NOISE_GLSL}
#include <fog_pars_fragment>
const vec3 CONCRETE = vec3(0.13, 0.118, 0.104);
const vec3 DIRT = vec3(0.075, 0.05, 0.032);
const vec3 HAZARD = vec3(0.72, 0.42, 0.02);
void main() {
  vec3 p = vWorld;
  vec3 n = normalize(vNormal);
  vec2 q = p.xz;
  float big = vnoise(q * 0.21);
  float mid = vnoise(q * 0.93 + 7.0);
  float fine = vnoise(q * 4.1 - 3.0);
  float dirtMask = smoothstep(0.42, 0.78, big * 0.65 + mid * 0.35);
  vec3 alb = mix(CONCRETE, DIRT, dirtMask) * (0.78 + 0.44 * fine);
  float ax = abs(p.x);
  float ao = 1.0;

  if (vKind < 0.5 || vKind > 2.5) {
    // Concrete slab seams every 4 units, filled with grime.
    vec2 g = abs(fract(q / 4.0 + 0.5) - 0.5) * 4.0;
    float seam = 1.0 - smoothstep(0.015, 0.06, min(g.x, g.y));
    alb *= 1.0 - 0.6 * seam * (1.0 - dirtMask);
    // Oil stains: dark, slightly blue-black blotches.
    float oil = smoothstep(0.64, 0.72, vnoise(q * 0.47 + 19.0) * 0.8 + fine * 0.2);
    alb = mix(alb, vec3(0.012, 0.012, 0.016), oil * 0.85);
    // Contact darkening where the floor meets the car walls.
    ao = mix(0.3, 1.0, smoothstep(${PIT_BACK.toFixed(2)}, ${(PIT_BACK + 3.2).toFixed(2)}, p.z));
    // The near side of the pit falls off into shadow: the eye stays on the fight.
    ao *= mix(1.0, 0.45, smoothstep(3.0, 16.0, p.z));
  }
  if (vKind < 0.5 && ax > ${HAZARD_IN.toFixed(3)}) {
    // Hazard band: diagonal stripes that run outward, worn through in places.
    float s = step(0.5, fract((ax + p.z) * 0.85));
    float wear = smoothstep(0.28, 0.55, vnoise(q * 2.6) * 0.7 + fine * 0.3);
    alb = mix(alb, mix(vec3(0.01), HAZARD, s), 0.92 * wear);
  } else if (vKind > 0.5 && vKind < 1.5) {
    // The lip: striped steel curb, stripes running along it.
    float s = step(0.5, fract((p.z + p.y) * 0.9));
    float wear = smoothstep(0.2, 0.5, vnoise(q * 3.1 + 4.0));
    alb = mix(vec3(0.05, 0.05, 0.055), mix(vec3(0.012), HAZARD * 1.1, s), wear);
  } else if (vKind > 1.5 && vKind < 2.5) {
    // The drop-off walls fade to black a few units down: nothing to stand on out there.
    alb = CONCRETE * (0.6 + 0.4 * fine) * exp(min(p.y, 0.0) * 0.55);
  }
  if (vKind > 2.5) ao *= 0.55; // outside the pit is in shadow

  vec3 light = ambient(n) * ao + floodLight(p, n) * ao + fireLight(p, n);
  vec3 col = alb * light;
  if (vKind < 0.5 || vKind > 2.5) {
    // Wet glints: the fires and floods catch in oil and damp concrete.
    float oilW = smoothstep(0.6, 0.72, vnoise(q * 0.47 + 19.0) * 0.8 + fine * 0.2);
    // Kept to the back half of the pit: big glints right under the camera read as noise.
    float wet = (0.12 + 0.88 * oilW) * ao * (1.0 - 0.85 * smoothstep(1.0, 8.0, p.z));
    vec3 v = normalize(cameraPosition - p);
    vec3 spec = vec3(0.0);
    for (int i = 0; i < 2; i++) {
      vec3 l = normalize(uFirePos[i] - p);
      spec += uFireCol[i] * pow(max(dot(n, normalize(l + v)), 0.0), 120.0) * 0.12;
    }
    for (int i = 0; i < FLOODS; i++) {
      vec3 l = normalize(uFloodPos[i] - p);
      float spot = smoothstep(uFloodCone.x, uFloodCone.y, dot(-l, uFloodDir[i]));
      spec += uFloodCol * spot * pow(max(dot(n, normalize(l + v)), 0.0), 140.0) * 2.0;
    }
    col += spec * wet;
  }
  gl_FragColor = vec4(col, 1.0);
  ${OUTPUT_GLSL}
}`;

export interface Floor {
  mesh: Mesh<import("three").BufferGeometry, ShaderMaterial>;
  triangles: number;
}

export function buildFloor(u: ArenaUniforms, floods: number): Floor {
  const b = new GeoBuilder({ aKind: 1 });
  const kind = (k: number) => (_p: unknown, _n: unknown, out: { aKind: Float32Array }) => {
    out.aKind[0] = k;
  };
  const m = new Matrix4();
  const flatUp = new PlaneGeometry(1, 1, 1, 1).rotateX(-Math.PI / 2);
  const facingPlusX = new PlaneGeometry(1, 1).rotateY(Math.PI / 2);
  const facingMinusX = new PlaneGeometry(1, 1).rotateY(-Math.PI / 2);
  const facingPlusZ = new PlaneGeometry(1, 1);

  // Pit floor: subdivided a little so fog and varyings stay well conditioned on long triangles.
  const pitLen = PIT_FRONT - PIT_BACK;
  const pit = new PlaneGeometry(2 * LIP_IN, pitLen, 4, 24).rotateX(-Math.PI / 2);
  b.add(pit, m.makeTranslation(0, 0, (PIT_BACK + PIT_FRONT) / 2), kind(PIT));

  // Raised lip, the outer face exactly on the ring edge; the drop-off on both sides.
  const lip = new BoxGeometry(RING_EDGE - LIP_IN, LIP_H, pitLen);
  const chasmW = CHASM_FAR - RING_EDGE;
  for (const s of [-1, 1]) {
    const mirror = new Matrix4().makeScale(s, 1, 1);
    const at = (x: number, y: number, z: number, sx: number, sy: number, sz: number) =>
      mirror.clone().multiply(new Matrix4().makeTranslation(x, y, z)).multiply(new Matrix4().makeScale(sx, sy, sz));
    b.add(lip, mirror.clone().multiply(new Matrix4().makeTranslation((LIP_IN + RING_EDGE) / 2, LIP_H / 2, (PIT_BACK + PIT_FRONT) / 2)), kind(LIP));
    // Far wall of the drop-off (faces the pit), its back end, and the floor far below.
    b.add(facingMinusX, at(CHASM_FAR, -CHASM_DEPTH / 2, (PIT_BACK + PIT_FRONT) / 2, 1, CHASM_DEPTH, pitLen), kind(CHASM));
    b.add(facingPlusZ, at(RING_EDGE + chasmW / 2, -CHASM_DEPTH / 2, PIT_BACK, chasmW, CHASM_DEPTH, 1), kind(CHASM));
    b.add(flatUp, at(RING_EDGE + chasmW / 2, -CHASM_DEPTH, (PIT_BACK + PIT_FRONT) / 2, chasmW, 1, pitLen), kind(CHASM));
    // The pit slab's own outer face (only seen from inside the drop-off, e.g. by a falling camera).
    b.add(facingPlusX, at(RING_EDGE, -CHASM_DEPTH / 2, (PIT_BACK + PIT_FRONT) / 2, 1, CHASM_DEPTH, pitLen), kind(CHASM));
    // Ground beyond the drop-off, where the end walls of cars stand.
    b.add(flatUp, at((CHASM_FAR + 42) / 2, 0, (PIT_BACK + PIT_FRONT) / 2, 42 - CHASM_FAR, 1, pitLen), kind(GROUND));
  }
  // Ground behind the pit, under the car wall and the bleachers.
  b.add(flatUp, new Matrix4().makeTranslation(0, 0, (PIT_BACK - 30) / 2).multiply(new Matrix4().makeScale(84, 1, 30 + PIT_BACK)), kind(GROUND));

  const geo = b.build();
  for (const g of [flatUp, facingPlusX, facingMinusX, facingPlusZ, pit, lip]) g.dispose();
  const mat = new ShaderMaterial({
    name: "arena-floor",
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: withFog(u),
    defines: { FLOODS: floods },
    fog: true,
  });
  const mesh = new Mesh(geo, mat);
  mesh.name = "arena-floor";
  mesh.renderOrder = -5;
  return { mesh, triangles: b.triangleCount };
}
