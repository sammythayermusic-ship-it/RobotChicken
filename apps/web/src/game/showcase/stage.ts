/**
 * Landing-page set dressing: a dark junkyard pit lit by a warm fire key and
 * magenta/cyan neon rims. Everything is procedural (zero asset bytes) and
 * scaled by `u`, the chicken's height, so it frames any model the same way.
 */
import {
  AdditiveBlending,
  BoxGeometry,
  CircleGeometry,
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  RingGeometry,
  TorusGeometry,
} from "three";

export const NEON_PINK = 0xff2e88;
export const NEON_CYAN = 0x22e5ff;
export const BACKDROP = 0x0a0710;

export interface Stage {
  group: Group;
  /** Advance the fire flicker; `t` is seconds since the showcase started. */
  update(t: number): void;
}

// Hand-placed wreck hulks behind the pit: [x, y, z, width, height, depth, yaw] in units of u.
const HULKS: readonly (readonly [number, number, number, number, number, number, number])[] = [
  [-5.2, 0.45, -5.5, 2.4, 0.9, 1.2, 0.3],
  [-5.0, 1.3, -5.7, 2.0, 0.8, 1.1, -0.2],
  [-2.2, 0.5, -7.5, 2.6, 1.0, 1.3, 0.1],
  [1.6, 0.45, -7.8, 2.2, 0.9, 1.2, -0.35],
  [1.9, 1.3, -7.6, 1.8, 0.8, 1.0, 0.2],
  [5.4, 0.5, -5.2, 2.4, 1.0, 1.2, -0.5],
  [6.8, 0.45, -3.0, 1.2, 0.9, 2.2, 0.15],
];
// Tire stacks: [x, z, count].
const TIRES: readonly (readonly [number, number, number])[] = [
  [-3.4, -3.1, 3],
  [-2.7, -3.6, 2],
  [3.6, -3.4, 4],
];

export function buildStage(u: number): Stage {
  const group = new Group();
  group.name = "stage";

  const floor = new Mesh(
    new CircleGeometry(16 * u, 48),
    new MeshStandardMaterial({ color: 0x17120f, roughness: 0.92, metalness: 0.25 }),
  );
  floor.rotation.x = -Math.PI / 2;
  group.add(floor);

  // The pit edge: a thin unlit neon tube plus a soft additive glow on the floor.
  // toneMapped:false keeps the neon saturated through ACES.
  const ringR = 2.2 * u;
  const tube = new Mesh(
    new TorusGeometry(ringR, 0.014 * u, 6, 128),
    new MeshBasicMaterial({ color: NEON_PINK, toneMapped: false }),
  );
  tube.rotation.x = Math.PI / 2;
  tube.position.y = 0.01 * u;
  const glow = new Mesh(
    new RingGeometry(ringR - 0.16 * u, ringR + 0.16 * u, 128),
    new MeshBasicMaterial({
      color: NEON_PINK,
      transparent: true,
      opacity: 0.16,
      blending: AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = 0.004 * u;
  group.add(tube, glow);

  const m = new Matrix4();
  const tmp = new Object3D();
  const hulks = new InstancedMesh(
    new BoxGeometry(1, 1, 1),
    new MeshStandardMaterial({ color: 0x3b2417, roughness: 0.82, metalness: 0.55 }),
    HULKS.length,
  );
  HULKS.forEach(([x, y, z, w, h, d, yaw], i) => {
    tmp.position.set(x * u, y * u, z * u);
    tmp.rotation.set(0, yaw, 0);
    tmp.scale.set(w * u, h * u, d * u);
    tmp.updateMatrix();
    hulks.setMatrixAt(i, tmp.matrix);
  });
  const tireCount = TIRES.reduce((n, [, , c]) => n + c, 0);
  const tires = new InstancedMesh(
    new TorusGeometry(0.34 * u, 0.13 * u, 8, 20),
    new MeshStandardMaterial({ color: 0x121212, roughness: 0.95, metalness: 0.05 }),
    tireCount,
  );
  let ti = 0;
  for (const [x, z, count] of TIRES) {
    for (let k = 0; k < count; k++) {
      m.makeRotationX(Math.PI / 2).setPosition(x * u + (k % 2) * 0.04 * u, (0.13 + 0.26 * k) * u, z * u);
      tires.setMatrixAt(ti++, m);
    }
  }
  group.add(hulks, tires);

  // Lights: dim violet ambience, a warm oil-drum key from front-left, a cool
  // fill, and the two neon rims from behind that carve the silhouettes.
  const hemi = new HemisphereLight(0x3d2c5c, 0x0c0806, 0.7);
  const key = new DirectionalLight(0xffa15a, 2.6);
  key.position.set(-3 * u, 4 * u, 4.5 * u);
  const fill = new DirectionalLight(0x5b6cff, 0.35);
  fill.position.set(4 * u, 1.5 * u, 3 * u);
  const rimL = new DirectionalLight(new Color(NEON_PINK), 3.4);
  rimL.position.set(-2.5 * u, 2.5 * u, -4 * u);
  const rimR = new DirectionalLight(new Color(NEON_CYAN), 3.4);
  rimR.position.set(2.5 * u, 2.5 * u, -4 * u);
  group.add(hemi, key, fill, rimL, rimR);

  const keyBase = key.intensity;
  return {
    group,
    update(t) {
      // Cheap fire flicker from incommensurate sines; purely cosmetic.
      const n = 0.5 * Math.sin(t * 11.3) + 0.3 * Math.sin(t * 17.9 + 1.3) + 0.2 * Math.sin(t * 5.1 + 0.4);
      key.intensity = keyBase * (0.92 + 0.08 * n);
    },
  };
}
