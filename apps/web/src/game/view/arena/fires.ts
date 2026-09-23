import {
  AdditiveBlending, InstancedBufferAttribute, InstancedBufferGeometry, Mesh, PlaneGeometry, PointLight, ShaderMaterial, type IUniform,
  type Vector2,
} from "three";
import type { FireCluster } from "./layout";
import { FIRE_COL, FIRE_POINT_I } from "./lighting";
import { rng } from "./rng";

/**
 * Oil-drum fires: flame tongues, a soft halo per drum and rising embers, all
 * instanced quads in ONE additive draw. Every particle loops in the vertex
 * shader from (uTime, seed): no CPU work per particle, ever. Brightness follows
 * the cluster's flicker, the same value that drives its PointLight.
 */
const FLAME = 0;
const HALO = 1;
const EMBER = 2;
const TONGUES = 10;
const EMBERS = 16;

const VERT = /* glsl */ `
attribute vec3 aCenter;
attribute vec4 aParams; // kind, seed, size, cluster
uniform float uTime;
uniform vec2 uFlick;
varying vec2 vUv;
varying float vKind;
varying float vAge;
varying float vFl;
void main() {
  float kind = aParams.x;
  float seed = aParams.y;
  float size = aParams.z;
  float fl = aParams.w < 0.5 ? uFlick.x : uFlick.y;
  vec3 c = aCenter;
  vec2 q = position.xy;
  float age = 0.0;
  if (kind < 0.5) {
    // Tongue: born at the coals, rises and sways, narrows, dies; loops forever.
    float life = 0.5 + 0.35 * fract(seed * 7.13);
    age = fract(uTime / life + seed);
    c += vec3(sin(uTime * 3.1 + seed * 40.0) * 0.12 * age, age * 1.1 * (0.6 + 0.5 * fl), cos(uTime * 2.3 + seed * 20.0) * 0.06 * age);
    size *= (1.0 - age * 0.6) * (0.75 + 0.35 * fl);
    q.y *= 1.25;
  } else if (kind < 1.5) {
    size *= 0.8 + 0.3 * fl;
  } else {
    // Ember: drifts up and sideways on the heat, fades out high above.
    float life = 1.8 + 1.6 * fract(seed * 3.7);
    age = fract(uTime / life + seed);
    c += vec3(sin(age * 6.0 + seed * 50.0) * 0.3 * age + (fract(seed * 9.1) - 0.5) * age * 1.4, age * 3.6, cos(age * 4.0 + seed * 30.0) * 0.25 * age);
    size *= 1.0 - age * 0.7;
  }
  vUv = uv;
  vKind = kind;
  vAge = age;
  vFl = fl;
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  gl_Position = projectionMatrix * viewMatrix * vec4(c + (right * q.x + up * q.y) * size, 1.0);
}`;

// Colours are display-space and may exceed 1 (additive, like fx/Particles), so no tone mapping here.
const FRAG = /* glsl */ `
varying vec2 vUv;
varying float vKind;
varying float vAge;
varying float vFl;
void main() {
  vec2 d = vUv - 0.5;
  vec3 col;
  float a;
  if (vKind < 0.5) {
    // Teardrop: round at the bottom, pinched at the top.
    float w = 1.0 - smoothstep(-0.5, 0.5, d.y) * 0.65;
    float r = length(vec2(d.x / w, d.y + 0.08)) * 2.0;
    float body = smoothstep(1.0, 0.15, r);
    col = mix(vec3(1.6, 1.25, 0.6), vec3(1.4, 0.42, 0.06), smoothstep(0.0, 0.45, vAge));
    col = mix(col, vec3(0.45, 0.06, 0.02), smoothstep(0.5, 1.0, vAge));
    a = body * (1.0 - vAge) * 0.6;
  } else if (vKind < 1.5) {
    float g = smoothstep(0.5, 0.0, length(d));
    col = vec3(1.0, 0.36, 0.08);
    a = g * g * 0.22 * vFl;
  } else {
    float g = smoothstep(0.5, 0.1, length(d));
    col = vec3(1.8, 0.7, 0.2);
    a = g * (1.0 - vAge) * step(0.12, fract(vAge * 7.0 + vFl));
  }
  if (a < 0.004) discard;
  gl_FragColor = vec4(col, a);
}`;

export interface Fires {
  mesh: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  lights: [PointLight, PointLight];
  update(flickL: number, flickR: number): void;
}

export function buildFires(clusters: readonly [FireCluster, FireCluster], shared: { uTime: IUniform<number>; uFlick: IUniform<Vector2> }, seed = 99): Fires {
  const rand = rng(seed);
  const center: number[] = [];
  const params: number[] = [];
  const push = (x: number, y: number, z: number, kind: number, size: number, cluster: number) => {
    center.push(x, y, z);
    params.push(kind, rand(), size, cluster);
  };
  clusters.forEach((cl, ci) => {
    for (const d of cl.drums) {
      for (let i = 0; i < TONGUES; i++) push(d.x + (rand() - 0.5) * 0.4, d.y + 0.95, d.z + (rand() - 0.5) * 0.4, FLAME, 0.55 + rand() * 0.35, ci);
      push(d.x, d.y + 1.25, d.z, HALO, 3.2, ci);
    }
    for (let i = 0; i < EMBERS; i++) {
      const d = cl.drums[i % cl.drums.length];
      if (d) push(d.x + (rand() - 0.5) * 0.4, d.y + 1.0, d.z + (rand() - 0.5) * 0.4, EMBER, 0.045 + rand() * 0.03, ci);
    }
  });

  const quad = new PlaneGeometry(1, 1);
  const geo = new InstancedBufferGeometry();
  geo.index = quad.index;
  geo.setAttribute("position", quad.getAttribute("position"));
  geo.setAttribute("uv", quad.getAttribute("uv"));
  geo.setAttribute("aCenter", new InstancedBufferAttribute(new Float32Array(center), 3));
  geo.setAttribute("aParams", new InstancedBufferAttribute(new Float32Array(params), 4));
  geo.instanceCount = center.length / 3;
  const mat = new ShaderMaterial({
    name: "arena-fire",
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: { uTime: shared.uTime, uFlick: shared.uFlick },
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
  const mesh = new Mesh(geo, mat);
  mesh.name = "arena-fire";
  mesh.frustumCulled = false;
  mesh.renderOrder = 15;

  // The two lights the FIGHTERS see (the arena itself is lit by the shared uniforms).
  const mk = (cl: FireCluster) => {
    const l = new PointLight(FIRE_COL, FIRE_POINT_I, 0, 2);
    l.position.set(cl.light.x, cl.light.y, cl.light.z);
    l.name = "arena-fire-light";
    return l;
  };
  const lights: [PointLight, PointLight] = [mk(clusters[0]), mk(clusters[1])];
  return {
    mesh,
    lights,
    update(fl, fr) {
      lights[0].intensity = FIRE_POINT_I * fl;
      lights[1].intensity = FIRE_POINT_I * fr;
    },
  };
}
