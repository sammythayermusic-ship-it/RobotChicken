/**
 * The showcase's fallback when the glb is missing or fails to load: a boxy
 * chicken built from primitives. It follows the glb contract where it matters
 * here (faces +Z, feet on y = 0, material names cf_*), so recolouring and
 * placement run through the same code as the real model.
 */
import {
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  type BufferGeometry,
  type Material,
} from "three";

export interface BoxChicken {
  root: Group;
  /** Nodded by the showcase's idle bob. */
  head: Group;
}

function mat(name: string, color: number, metalness: number, roughness: number, emissive = 0): MeshStandardMaterial {
  const m = new MeshStandardMaterial({ color, metalness, roughness, emissive, emissiveIntensity: emissive ? 2 : 0 });
  m.name = name;
  return m;
}

function part(geo: BufferGeometry, material: Material, x: number, y: number, z: number): Mesh {
  const mesh = new Mesh(geo, material);
  mesh.position.set(x, y, z);
  return mesh;
}

export function buildBoxChicken(): BoxChicken {
  const shell = mat("cf_shell", 0xb4532a, 0.65, 0.5);
  const trim = mat("cf_trim", 0x3c4046, 0.85, 0.35);
  const eye = mat("cf_eye", 0x111111, 0.2, 0.4, 0xfff0a0);
  const beak = mat("cf_beak", 0xe3a534, 0.5, 0.45);
  const comb = mat("cf_comb", 0xd22f2a, 0.4, 0.5);

  const root = new Group();
  root.name = "box_chicken";
  root.add(
    part(new BoxGeometry(0.9, 0.8, 1.1), shell, 0, 0.8, 0),
    part(new BoxGeometry(0.94, 0.28, 0.55), trim, 0, 0.62, 0.3),
    part(new BoxGeometry(0.62, 0.55, 0.16), trim, 0, 1.12, -0.6),
    part(new CylinderGeometry(0.06, 0.06, 0.42, 8), trim, -0.22, 0.21, 0),
    part(new CylinderGeometry(0.06, 0.06, 0.42, 8), trim, 0.22, 0.21, 0),
  );

  const head = new Group();
  head.position.set(0, 1.3, 0.38);
  const beakMesh = part(new ConeGeometry(0.12, 0.32, 4), beak, 0, -0.02, 0.4);
  beakMesh.rotation.x = Math.PI / 2;
  head.add(
    part(new BoxGeometry(0.5, 0.5, 0.52), shell, 0, 0.05, 0),
    beakMesh,
    part(new BoxGeometry(0.1, 0.26, 0.42), comb, 0, 0.42, -0.02),
    part(new BoxGeometry(0.04, 0.09, 0.09), eye, -0.26, 0.1, 0.12),
    part(new BoxGeometry(0.04, 0.09, 0.09), eye, 0.26, 0.1, 0.12),
  );
  root.add(head);
  return { root, head };
}
