import { AdditiveBlending, type BufferGeometry, CylinderGeometry, DoubleSide, Matrix4, Mesh, Object3D, PlaneGeometry, ShaderMaterial, Vector3, type IUniform } from "three";
import { GeoBuilder } from "./builder";
import { BEACONS, type Floodlight, type Vec3Like } from "./layout";
import { FLOOD_CONE, NOISE_GLSL } from "./lighting";

/**
 * Floodlight beams and lamp flares in ONE additive draw.
 *
 * A beam is an open cone. A flat additive surface seen face-on paints a hard
 * wedge (the soltendogs light-shaft lesson), so its opacity is gated by how
 * squarely the eye looks through it (|N.V|: bright down the middle, gone at
 * the silhouette), fades along its length and near the floor, and drifts with
 * slow dust noise. Flares are camera-facing quads at the lamp banks.
 */
const CONE = 0;
const FLARE = 1;
const HAZE = 2;
const BEACON = 3;
/**
 * A shaft fades out between these fractions of its lamp-to-floor length
 * (`along`). Past the second it is fully transparent, so the cone is only
 * built that far: the wide end would be shaded and discarded for nothing.
 */
export const SHAFT_FADE = [0.3, 0.85] as const;

const VERT = /* glsl */ `
attribute vec3 aCenter;
attribute vec4 aParams; // kind, size, along (0 at the lamp), seed
varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vQ;
varying float vKind;
varying float vAlong;
varying float vSeed;
void main() {
  vKind = aParams.x;
  vAlong = aParams.z;
  vSeed = aParams.w;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vec3 wp;
  vQ = vec2(0.0);
  if (aParams.x < 0.5 || (aParams.x > 1.5 && aParams.x < 2.5)) {
    wp = (modelMatrix * vec4(position, 1.0)).xyz;
  } else {
    vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    wp = aCenter + (right * position.x * 2.6 + up * position.y) * aParams.y;
    vQ = position.xy;
  }
  vWorld = wp;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;

const FRAG = /* glsl */ `
uniform float uTime;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vQ;
varying float vKind;
varying float vAlong;
varying float vSeed;
${NOISE_GLSL}
void main() {
  vec3 col;
  float a;
  if (vKind < 0.5) {
    vec3 v = normalize(cameraPosition - vWorld);
    float facing = abs(dot(normalize(vNormal), v));
    float dust = 0.65 + 0.35 * vnoise(vWorld.xy * 0.9 + vec2(vWorld.z * 0.5, -uTime * 0.25));
    // Shafts show near the lamps and dissolve before the two cones cross over the pit (their
    // overlap reads as a glowing spindle); the floor pools carry the light the rest of the way.
    a = facing * facing * (1.0 - smoothstep(${SHAFT_FADE[0].toFixed(3)}, ${SHAFT_FADE[1].toFixed(3)}, vAlong)) * dust * 0.32;
    col = vec3(0.55, 0.68, 1.0);
  } else if (vKind > 2.5) {
    // Rotating amber beacon: a sweeping flash on a dim glow.
    float r = length(vQ * vec2(2.6, 1.0));
    float sweep = pow(max(0.0, cos(uTime * 4.2 + vSeed * 2.1)), 8.0);
    a = smoothstep(0.5, 0.0, r) * (0.25 + 0.9 * sweep);
    col = vec3(1.6, 0.75, 0.12);
  } else if (vKind > 1.5) {
    // Haze: smoke hanging over the car wall, lit from above, so the crowd sits back in the air.
    float drift = 0.7 + 0.3 * vnoise(vec2(vWorld.x * 0.25 + uTime * 0.06, vWorld.y * 0.5));
    a = smoothstep(2.0, 3.2, vWorld.y) * (1.0 - smoothstep(3.2, 8.5, vWorld.y)) * drift * 0.06;
    col = vec3(0.55, 0.6, 0.75);
  } else {
    // Flare: a hot core plus a thin horizontal streak.
    vec2 q = vQ * vec2(2.6, 1.0);
    float core = smoothstep(0.5, 0.0, length(q));
    float streak = smoothstep(0.5, 0.0, abs(vQ.y) * 9.0) * smoothstep(0.5, 0.05, abs(vQ.x));
    if (vSeed > 0.5) {
      a = core;
      col = vec3(1.4, 0.85, 0.4);
    } else {
      a = core * core * 0.9 + streak * 0.35;
      col = vec3(0.8, 0.9, 1.25);
    }
  }
  if (a < 0.002) discard;
  gl_FragColor = vec4(col, a);
}`;

export function buildBeams(floods: readonly Floodlight[], bulbs: readonly Vec3Like[], uTime: IUniform<number>): Mesh<BufferGeometry, ShaderMaterial> {
  const b = new GeoBuilder({ aCenter: 3, aParams: 4 });
  const halfAngle = Math.acos(FLOOD_CONE.x) * 0.92;
  const obj = new Object3D();
  const from = new Vector3();
  const to = new Vector3();
  const axis = new Vector3();
  const rel = new Vector3();
  floods.forEach((f, i) => {
    from.set(f.pos.x, f.pos.y, f.pos.z);
    to.set(f.target.x, f.target.y, f.target.z);
    const len = from.distanceTo(to);
    axis.subVectors(to, from).normalize();
    // `along` runs from a0 at the lamp ring (radius 0.5) to 1 at the floor, linearly in the axial
    // fraction s; the cone stops at s1, where along reaches the end of the fade.
    const a0 = 0.5 / len;
    const s1 = (SHAFT_FADE[1] - a0) / (1 - a0);
    if (s1 > 0) {
      const h = s1 * len;
      // Open cone, apex end at the lamp. Its local +y is the beam axis, pointing back at the lamp.
      const cone = new CylinderGeometry(0.5, 0.5 + Math.tan(halfAngle) * h, h, 28, 1, true).translate(0, -h / 2, 0);
      obj.position.copy(from);
      obj.up.set(0, 0, 1); // not +y: a glb lamp aimed straight down would make lookAt degenerate
      obj.lookAt(to);
      obj.rotateX(-Math.PI / 2); // lookAt aims +z; the cone runs along -y
      obj.updateMatrix();
      b.add(cone, obj.matrix, (p, _n, out) => {
        const s = rel.subVectors(p, from).dot(axis) / len;
        out.aParams[0] = CONE;
        out.aParams[2] = a0 + s * (1 - a0);
        out.aParams[3] = i;
      });
      cone.dispose();
    }
    const quad = new PlaneGeometry(1, 1);
    b.add(quad, new Matrix4(), (_p, _n, out) => {
      out.aCenter[0] = f.pos.x;
      out.aCenter[1] = f.pos.y;
      out.aCenter[2] = f.pos.z + 0.25;
      out.aParams[0] = FLARE;
      out.aParams[1] = 1.7;
    });
    quad.dispose();
  });
  // String-light bulbs: small warm flares (seed 1 = warm; some bulbs dimmer, a couple dead).
  const bulbQuad = new PlaneGeometry(1, 1);
  bulbs.forEach((q, i) => {
    const dead = (i * 7 + 3) % 11 === 0;
    b.add(bulbQuad, new Matrix4(), (_p, _n, out) => {
      out.aCenter[0] = q.x;
      out.aCenter[1] = q.y;
      out.aCenter[2] = q.z + 0.05;
      out.aParams[0] = FLARE;
      out.aParams[1] = dead ? 0 : 0.2 + ((i * 13) % 5) * 0.02;
      out.aParams[3] = 1;
    });
  });
  BEACONS.forEach((q, i) => {
    b.add(bulbQuad, new Matrix4(), (_p, _n, out) => {
      out.aCenter[0] = q.x;
      out.aCenter[1] = q.y + 0.03;
      out.aCenter[2] = q.z + 0.1;
      out.aParams[0] = BEACON;
      out.aParams[1] = 0.55;
      out.aParams[3] = i;
    });
  });
  bulbQuad.dispose();
  // One haze sheet just behind the car wall, across the whole view.
  const sheet = new PlaneGeometry(1, 1);
  b.add(sheet, new Matrix4().makeTranslation(0, 5.5, -10.6).multiply(new Matrix4().makeScale(56, 7, 1)), (_p, _n, out) => {
    out.aParams[0] = HAZE;
  });
  sheet.dispose();
  const mat = new ShaderMaterial({
    name: "arena-beams",
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: { uTime },
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: AdditiveBlending,
  });
  const mesh = new Mesh(b.build(), mat);
  mesh.name = "arena-beams";
  mesh.frustumCulled = false;
  mesh.renderOrder = 16;
  return mesh;
}
