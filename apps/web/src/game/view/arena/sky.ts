import { BackSide, Mesh, ShaderMaterial, SphereGeometry, type IUniform } from "three";
import { NOISE_GLSL } from "./lighting";

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  // Direction from the camera, so the sky sits at infinity whatever the dolly does.
  vDir = (modelMatrix * vec4(position, 1.0)).xyz - cameraPosition;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww; // on the far plane: behind everything, passes only where nothing was drawn
}`;

/**
 * Night sky over the junkyard: a smoggy gradient that glows warm near the
 * horizon behind the pit (fires, city), distant junk-heap and crane
 * silhouettes with blinking red tip lights, and a few stars. All procedural;
 * mostly seen in tall (portrait) views and through gaps above the crowd.
 */
const FRAG = /* glsl */ `
uniform float uTime;
varying vec3 vDir;
${NOISE_GLSL}
float heap(float az) {
  // Jagged scrap mountains: broad hills plus sharp junk teeth.
  float h = 0.07 + 0.05 * vnoise(vec2(az * 2.2, 3.1)) + 0.025 * vnoise(vec2(az * 9.0, 7.7));
  h += 0.012 * abs(fract(az * 31.0) - 0.5) * vnoise(vec2(az * 17.0, 1.3));
  return h;
}
float crane(float az, float e, float c, float top, float jibL, float jibR) {
  float mast = step(abs(az - c), 0.0035) * step(e, top);
  float jib = step(abs(e - top + 0.006), 0.0035) * step(c - jibL, az) * step(az, c + jibR);
  float tie = step(abs(e - (top + 0.02) + abs(az - c) * 0.35), 0.0015) * step(c - jibL, az) * step(az, c + jibR) * step(e, top + 0.02);
  return max(max(mast, jib), tie);
}
void main() {
  vec3 d = normalize(vDir);
  float e = d.y;
  float az = atan(d.x, -d.z); // 0 = straight behind the pit
  vec3 zenith = vec3(0.003, 0.004, 0.01);
  vec3 horizon = vec3(0.028, 0.019, 0.017);
  vec3 col = mix(horizon, zenith, smoothstep(0.08, 0.4, e));
  // Warm smog glow behind the arena, cold floodlit haze higher up.
  col += vec3(0.05, 0.022, 0.01) * exp(-az * az * 1.2) * (1.0 - smoothstep(0.08, 0.3, e));
  col += vec3(0.015, 0.02, 0.035) * exp(-az * az * 3.0) * smoothstep(0.05, 0.2, e) * (1.0 - smoothstep(0.2, 0.6, e));
  // Stars, only well above the smog.
  vec2 sg = vec2(az * 180.0, e * 180.0);
  float star = step(0.9965, hash12(floor(sg))) * smoothstep(0.25, 0.5, e);
  col += vec3(0.5, 0.55, 0.7) * star * (0.4 + 0.6 * hash12(floor(sg) + 3.0));
  // Skyline.
  float s = step(e, heap(az));
  s = max(s, crane(az, e, -0.31, 0.24, 0.09, 0.05));
  s = max(s, crane(az, e, 0.27, 0.21, 0.04, 0.1));
  s = max(s, crane(az, e, 0.9, 0.2, 0.07, 0.04));
  vec3 sil = vec3(0.006, 0.005, 0.006) + horizon * 0.15;
  col = mix(col, sil, s);
  // Blinking aviation lights on the crane tips.
  float blink = step(0.5, fract(uTime * 0.7));
  float tips = 0.0;
  tips += smoothstep(0.006, 0.0, length(vec2(az + 0.31, e - 0.246)));
  tips += smoothstep(0.006, 0.0, length(vec2(az - 0.27, e - 0.216)));
  tips += smoothstep(0.006, 0.0, length(vec2(az - 0.9, e - 0.206)));
  col += vec3(2.5, 0.12, 0.05) * tips * blink;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export function buildSky(uTime: IUniform<number>): Mesh<SphereGeometry, ShaderMaterial> {
  const mat = new ShaderMaterial({
    name: "arena-sky",
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: { uTime },
    side: BackSide,
    depthWrite: false,
  });
  const mesh = new Mesh(new SphereGeometry(150, 32, 12), mat);
  mesh.name = "arena-sky";
  // Last among the opaques: it sits on the far plane (depth 1), so everything already drawn
  // rejects it and only the visible sky gets shaded.
  mesh.renderOrder = 10;
  mesh.frustumCulled = false;
  return mesh;
}
