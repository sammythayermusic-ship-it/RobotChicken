import { Group, Mesh, MeshBasicMaterial, PlaneGeometry, type WebGLRenderer } from "three";
import type { ArenaView } from "../FightView";

/** Placeholder arena (replaced by the procedural junkyard). */
export async function createJunkyard(_renderer: WebGLRenderer): Promise<ArenaView> {
  const root = new Group();
  const floor = new Mesh(new PlaneGeometry(24, 12), new MeshBasicMaterial({ color: 0x2a2320 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.z = -2;
  root.add(floor);
  return {
    root,
    setHype: () => {},
    update: () => {},
    dispose: () => {
      floor.geometry.dispose();
      (floor.material as MeshBasicMaterial).dispose();
      root.removeFromParent();
    },
  };
}
