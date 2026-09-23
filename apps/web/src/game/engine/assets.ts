/**
 * One shared GLTFLoader + DRACOLoader (+ KTX2Loader once a renderer exists)
 * and a promise cache of loaded glTFs.
 *
 * The loaders are module singletons and are never disposed: each owns a
 * decoder worker pool, and tearing that down on every React remount would
 * refetch and recompile the wasm. Cached GLTFs are shared too; consumers
 * `SkeletonUtils.clone` the scene and may release GPU resources on dispose
 * (three re-uploads geometry, materials and textures on next use), but must
 * never mutate the cached source.
 *
 * Import addons by path, never through the `three/addons` barrel.
 *
 * Bundler note (checked with a real Turbopack production build, three r186):
 * the Draco and KTX2 loaders default their decoder URLs with a module-level
 * `new URL("../libs/...", import.meta.url)`. Turbopack does not fail on it; it
 * emits those files as hashed static media that nothing requests, because the
 * paths set below always replace the defaults before any decode.
 */
import type { WebGLRenderer } from "three";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import { decoderPaths } from "./decoders";

export type { GLTF };

let gltfLoader: GLTFLoader | null = null;
let ktx2Loader: KTX2Loader | null = null;
const cache = new Map<string, Promise<GLTF>>();

function loader(): GLTFLoader {
  if (!gltfLoader) {
    // A string path makes DRACOLoader fetch draco_wasm_wrapper.js + the wasm
    // (draco_decoder.js only if WebAssembly is missing), all same-origin.
    const draco = new DRACOLoader().setDecoderPath(decoderPaths().draco);
    gltfLoader = new GLTFLoader().setDRACOLoader(draco);
  }
  return gltfLoader;
}

/**
 * Enables KTX2 (KHR_texture_basisu) textures. KTX2Loader must know which GPU
 * formats the device supports before it transcodes anything, and only a live
 * renderer can say, so it is created lazily on the first call. Nothing is
 * fetched until a KTX2 texture is actually loaded. Capabilities are a property
 * of the device, so the first renderer's answer holds for later ones.
 */
export function enableKtx2(renderer: WebGLRenderer): void {
  if (ktx2Loader) return;
  ktx2Loader = new KTX2Loader().setTranscoderPath(decoderPaths().basis).detectSupport(renderer);
  loader().setKTX2Loader(ktx2Loader);
}

/**
 * Loads (once) and caches a glTF by URL. Pass the renderer when the file may
 * carry KTX2 textures. A failed load is evicted so a later call can retry.
 */
export function loadGltf(url: string, renderer?: WebGLRenderer): Promise<GLTF> {
  if (renderer) enableKtx2(renderer);
  let p = cache.get(url);
  if (!p) {
    p = loader().loadAsync(url);
    cache.set(url, p);
    p.catch(() => {
      if (cache.get(url) === p) cache.delete(url);
    });
  }
  return p;
}
