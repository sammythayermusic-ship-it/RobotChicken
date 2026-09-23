import {
  BoxGeometry,
  DataTexture,
  Group,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Scene,
  Texture,
  type Material,
  type Object3D,
  type WebGLRenderer,
} from "three";
import { describe, expect, it } from "vitest";
import { disposeRenderer, releaseGpu } from "./disposeRenderer";

/**
 * Just enough of a three r186 WebGLRenderer to reproduce the retention:
 * - a record per drawn material, which material.dispose() deletes
 *   (WebGLRenderer's onMaterialDispose). For physically based materials the
 *   record's uniforms point at the shared DFG LUT.
 * - a 'dispose' listener on the LUT per renderer that uploaded it, removed
 *   only when it fires (WebGLTextures' onTextureDispose). While it is
 *   attached, the module-level LUT keeps the renderer reachable.
 */
function fakeRenderer(lut: Texture) {
  const records = new WeakMap<object, Record<string, unknown>>();
  const state = { lutReleased: 0, disposed: 0, contextLost: 0 };
  const onLutDispose = () => {
    state.lutReleased++;
    lut.removeEventListener("dispose", onLutDispose);
  };
  const renderer = {
    properties: {
      has: (o: object) => records.has(o),
      get: (o: object) => {
        let r = records.get(o);
        if (!r) records.set(o, (r = {}));
        return r;
      },
    },
    dispose: () => void state.disposed++,
    forceContextLoss: () => void state.contextLost++,
  };
  /** What rendering `root` once leaves behind. */
  const draw = (root: Object3D) => {
    root.traverse((o) => {
      const material = (o as Mesh).material as Material | undefined;
      if (!material || records.has(material)) return;
      const pbr = (material as MeshStandardMaterial).isMeshStandardMaterial === true;
      records.set(material, { uniforms: pbr ? { dfgLUT: { value: lut } } : {} });
      material.addEventListener("dispose", () => records.delete(material));
      if (pbr && !lut.hasEventListener("dispose", onLutDispose)) lut.addEventListener("dispose", onLutDispose);
    });
  };
  const holdsLut = () => lut.hasEventListener("dispose", onLutDispose);
  return { renderer: renderer as unknown as WebGLRenderer, draw, holdsLut, state };
}

function makeLut(): Texture {
  const lut = new DataTexture(new Uint16Array(16 * 16 * 2), 16, 16);
  lut.name = "DFG_LUT";
  return lut;
}

function pbrScene(): Scene {
  const scene = new Scene();
  scene.add(new Mesh(new BoxGeometry(), new MeshStandardMaterial()), new Mesh(new BoxGeometry(), new MeshBasicMaterial()));
  return scene;
}

describe("disposeRenderer", () => {
  it("detaches the disposed renderer, and any other, from three's shared DFG LUT", () => {
    const lut = makeLut();
    const a = fakeRenderer(lut);
    const b = fakeRenderer(lut);
    const sceneA = pbrScene();
    const sceneB = pbrScene();
    a.draw(sceneA);
    b.draw(sceneB);
    expect(a.holdsLut() && b.holdsLut()).toBe(true);

    disposeRenderer(a.renderer, sceneA);

    // Found although releasing sceneA's materials deleted the records that
    // pointed at it: the lookup must run first.
    expect(a.holdsLut()).toBe(false);
    expect(a.state).toEqual({ lutReleased: 1, disposed: 1, contextLost: 1 });
    // A live renderer drops its GL copy too, and re-uploads it on its next frame.
    expect(b.holdsLut()).toBe(false);
    expect(b.state.lutReleased).toBe(1);
  });

  it("still releases the LUT when the scene no longer holds a drawn material", () => {
    const lut = makeLut();
    const first = fakeRenderer(lut);
    const firstScene = pbrScene();
    first.draw(firstScene);
    disposeRenderer(first.renderer, firstScene);

    const later = fakeRenderer(lut);
    const laterScene = pbrScene();
    later.draw(laterScene);
    // The caller swapped the drawn meshes out (and freed them) before teardown.
    const drawn = [...laterScene.children];
    for (const o of drawn) releaseGpu(o);
    laterScene.clear();
    expect(later.holdsLut()).toBe(true);

    disposeRenderer(later.renderer, laterScene);
    expect(later.holdsLut()).toBe(false);
  });

  it("looks in every scene it is given", () => {
    const lut = makeLut();
    const r = fakeRenderer(lut);
    const world = new Scene();
    const hud = pbrScene();
    r.draw(world);
    r.draw(hud);
    disposeRenderer(r.renderer, world, hud);
    expect(r.holdsLut()).toBe(false);
  });
});

describe("releaseGpu", () => {
  it("disposes each geometry, material, texture and instance buffer once", () => {
    const disposed = new Map<object, number>();
    const track = <T extends { addEventListener(type: "dispose", fn: () => void): void }>(o: T): T => {
      o.addEventListener("dispose", () => disposed.set(o, (disposed.get(o) ?? 0) + 1));
      return o;
    };
    const map = track(new Texture());
    const background = track(new Texture());
    const geometry = track(new BoxGeometry());
    const material = track(new MeshStandardMaterial({ map }));
    const instanceGeometry = track(new BoxGeometry());
    const instanceMaterial = track(new MeshBasicMaterial());
    const instances = track(new InstancedMesh(instanceGeometry, instanceMaterial, 4));

    const scene = new Scene();
    scene.background = background;
    const nested = new Group();
    // Shared geometry and material: released once however many meshes use them.
    nested.add(new Mesh(geometry, material), new Mesh(geometry, [material, material]));
    scene.add(nested, instances);

    releaseGpu(scene);

    for (const o of [map, background, geometry, material, instanceGeometry, instanceMaterial, instances]) {
      expect(disposed.get(o), (o as { type?: string }).type).toBe(1);
    }
  });
});
