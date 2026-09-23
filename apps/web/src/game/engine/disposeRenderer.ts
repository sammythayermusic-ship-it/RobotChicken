/**
 * Tearing down a WebGLRenderer so that nothing keeps it alive afterwards.
 *
 * `renderer.dispose()` is not enough in three r186. WebGLRenderer hands every
 * physically based material (MeshStandardMaterial and up, which covers the
 * glTF loader's output) one module-level 16x16 DataTexture, the DFG LUT, and
 * that texture is not exported. Each renderer that uploads it adds a
 * 'dispose' listener to it that captures its own GL context and texture
 * state. Only that listener removes itself, and it runs only when the LUT is
 * disposed, which three never does. So every renderer ever created would stay
 * reachable from three's module state, along with its canvas and context.
 *
 * Disposing the LUT fires every renderer's listener and removes them all. A
 * renderer that is still in use re-uploads the texture on its next frame,
 * because the data stays on the CPU. That is 1 KB, once.
 */
import type { Material, Mesh, Object3D, Scene, SkinnedMesh, Texture, WebGLRenderer } from "three";

/** What WebGLRenderer keeps per material. Only the part read here is typed. */
interface MaterialRecord {
  uniforms?: { dfgLUT?: { value?: Texture | null } };
}

/**
 * Every shared texture seen so far. The LUT is a single object for the life
 * of the page, so remembering it costs nothing and still finds it when a later
 * scene holds no material that the renderer has drawn.
 */
const shared = new Set<Texture>();

function materialsOf(o: Object3D): Material[] {
  const m = (o as Mesh).material as Material | Material[] | undefined;
  return Array.isArray(m) ? m : m ? [m] : [];
}

/**
 * Finds the textures that `renderer` has attached to materials under `root`
 * but that no material owns (today only the DFG LUT). Call this before
 * disposing the materials: disposing a material deletes the renderer's
 * record of it, and the LUT reference goes with that record.
 */
export function rendererSharedTextures(renderer: WebGLRenderer, root: Object3D): Set<Texture> {
  const found = new Set<Texture>();
  root.traverse((o) => {
    for (const material of materialsOf(o)) {
      if (!renderer.properties.has(material)) continue;
      const lut = (renderer.properties.get(material) as MaterialRecord).uniforms?.dfgLUT?.value;
      if (lut?.isTexture) found.add(lut);
    }
  });
  return found;
}

/**
 * Frees the GPU side of everything under `root`: geometries, materials, their
 * textures, skeleton bone textures, instanced-mesh buffers and a scene's
 * background and environment textures. CPU data is left alone and three
 * re-uploads it on next use, so cached glTFs whose resources these objects
 * share stay valid for the next consumer.
 */
export function releaseGpu(root: Object3D): void {
  const seen = new Set<{ dispose(): void }>();
  const release = (r: { dispose(): void } | null | undefined) => {
    if (r && !seen.has(r)) {
      seen.add(r);
      r.dispose();
    }
  };
  const texture = (v: unknown) => ((v as Texture | null)?.isTexture ? (v as Texture) : null);
  const scene = root as Partial<Scene>;
  release(texture(scene.background));
  release(texture(scene.environment));
  root.traverse((o) => {
    const mesh = o as Mesh & Partial<SkinnedMesh> & { isInstancedMesh?: boolean };
    if (!mesh.isMesh) return;
    release(mesh.geometry);
    if (mesh.isSkinnedMesh) release(mesh.skeleton);
    // Frees the instance buffers (and morph texture); geometry and material are separate.
    if (mesh.isInstancedMesh) mesh.dispose();
    for (const m of materialsOf(mesh)) {
      for (const v of Object.values(m)) release(texture(v));
      release(m);
    }
  });
}

/**
 * Releases the GPU resources under each of `scenes`, then the renderer and
 * its context, and detaches the renderer from three's module-level state so
 * the renderer, its canvas and its context can be garbage collected. The
 * caller still removes the canvas from the page.
 *
 * Pass every scene the renderer has drawn: the shared textures are found
 * through their materials.
 */
export function disposeRenderer(renderer: WebGLRenderer, ...scenes: Object3D[]): void {
  for (const scene of scenes) for (const t of rendererSharedTextures(renderer, scene)) shared.add(t);
  for (const scene of scenes) releaseGpu(scene);
  // Fires each renderer's listener, which deletes its GL copy and removes itself.
  for (const t of shared) t.dispose();
  renderer.dispose();
  renderer.forceContextLoss();
}
