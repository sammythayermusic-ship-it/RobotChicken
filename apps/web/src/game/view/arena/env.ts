import { BackSide, BoxGeometry, CircleGeometry, Color, Group, Mesh, MeshBasicMaterial, Scene, SphereGeometry } from "three";
import type { ArenaAnchors } from "./layout";

/**
 * A tiny stand-in junkyard that FightView renders once into a PMREM env map,
 * so chrome / gold / diamond chickens reflect the arena instead of a studio:
 * fire orange low at the back, cold floodlight panels high in the corners,
 * rusty walls, the floodlit pool on the floor. Unlit HDR colours
 * (MeshBasicMaterial), ~25 boxes.
 *
 * It is brighter than the real arena on purpose. A mirror-like chicken facing
 * the camera reflects what is BEHIND the camera (nothing, in the real scene),
 * and a black reflection makes chrome read as dark paint. So the camera side
 * gets "near stands" with a lit rail and lamps: contrasty bands that read as
 * metal.
 */
export function buildEnvScene(a: ArenaAnchors): Scene {
  const scene = new Scene();
  scene.background = new Color(0.03, 0.033, 0.05);
  // PMREMGenerator.fromScene renders from the origin; shift the set down so
  // the probe sits at chicken-body height instead of on the floor.
  const set = new Group();
  set.position.y = -1;
  scene.add(set);
  const box = new BoxGeometry(1, 1, 1);
  const add = (color: Color, x: number, y: number, z: number, sx: number, sy: number, sz: number) => {
    const m = new Mesh(box, new MeshBasicMaterial({ color }));
    m.position.set(x, y, z);
    m.scale.set(sx, sy, sz);
    set.add(m);
  };
  set.add(new Mesh(new SphereGeometry(60, 16, 8), new MeshBasicMaterial({ color: new Color(0.04, 0.042, 0.065), side: BackSide })));
  add(new Color(0.06, 0.05, 0.042), 0, -0.05, 0, 80, 0.1, 80); // floor
  const pool = new Mesh(new CircleGeometry(5, 24), new MeshBasicMaterial({ color: new Color(0.45, 0.5, 0.62) }));
  pool.rotation.x = -Math.PI / 2;
  pool.position.set(0, 0.01, -0.8);
  set.add(pool); // the floodlit pool under the fighters
  add(new Color(0.2, 0.09, 0.05), 0, 1.5, -9, 40, 3, 2); // car wall behind (fire-lit rust)
  add(new Color(0.14, 0.07, 0.045), -14, 1.5, 0, 2, 3, 24); // end walls
  add(new Color(0.09, 0.09, 0.13), 14, 1.5, 0, 2, 3, 24);
  add(new Color(0.07, 0.075, 0.11), 0, 5.5, -15, 40, 5, 6); // bleachers + crowd in the haze
  add(new Color(1.6, 1.0, 0.5), 0, 3.8, -9.2, 32, 0.12, 0.2); // string lights
  // Camera side: dim near stands, a lit rail and work lamps.
  add(new Color(0.22, 0.23, 0.29), 0, 3, 18, 60, 6, 2);
  add(new Color(2.2, 2.3, 2.6), 0, 2.2, 16.8, 60, 0.4, 0.3);
  for (const x of [-12, -6, 0, 6, 12]) add(new Color(7, 4.2, 2), x, 5.2, 16.8, 1.6, 0.8, 0.3);
  for (const cl of a.fires) {
    for (const d of cl.drums) add(new Color(8, 2.8, 0.6), d.x, d.y + 1.1, d.z, 0.7, 0.9, 0.7);
    add(new Color(1.8, 0.55, 0.12), cl.light.x, 0.6, cl.light.z + 1, 3.5, 1.2, 0.5); // fire-lit floor glow
  }
  for (const f of a.floods) add(new Color(14, 15, 18), f.pos.x, f.pos.y, f.pos.z, 2.4, 1.6, 0.4);
  return scene;
}

export function disposeEnvScene(scene: Scene): void {
  scene.traverse((o) => {
    if (o instanceof Mesh) {
      o.geometry.dispose();
      (o.material as MeshBasicMaterial).dispose();
    }
  });
}
