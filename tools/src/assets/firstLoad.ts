/**
 * The first-load table: every file a new player downloads before the first
 * fight, which the spec caps at 12 MB "on the wire". Counted as raw bytes, an
 * upper bound: glb and KTX2 barely compress, and gzip only helps the decoders.
 *
 * On first load: the chicken glb, the Draco decoder (when a glb uses Draco),
 * the Rust tier textures, Sammy's arena glb + lightmap when they exist, audio
 * overrides in public/audio, and the Basis transcoder once any KTX2 is among
 * those. Lazy (listed, not counted): the Chrome, Gold and Diamond tier sets.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readGlbJson, toRepo } from "./gltf";
import { listFiles, type LooseFile } from "./textures";

export interface LoadItem extends LooseFile {
  /** What the file is, e.g. "chicken", "Draco decoder". */
  what: string;
}

export interface FirstLoad {
  items: LoadItem[];
  /** Not counted: loaded after the first fight starts (other tiers). */
  lazy: LoadItem[];
  total: number;
  budget: number;
}

/** three's examples/jsm/libs, the source scripts/copy-decoders.mjs copies into public/decoders/r<REV>/. */
export function threeLibsDir(): string {
  // three/package.json is not in three's exports map; three/src/* is.
  const constants = createRequire(import.meta.url).resolve("three/src/constants.js");
  return join(dirname(constants), "..", "examples", "jsm", "libs");
}

/** The decoder files the runtime fetches (DRACOLoader: wrapper + wasm; KTX2Loader: transcoder js + wasm). */
export const DECODERS = {
  draco: ["draco/gltf/draco_wasm_wrapper.js", "draco/gltf/draco_decoder.wasm"],
  basis: ["basis/basis_transcoder.js", "basis/basis_transcoder.wasm"],
} as const;

function file(path: string, what: string): LoadItem {
  return { file: toRepo(path), bytes: statSync(path).size, what };
}

export interface FirstLoadInput {
  /** The chicken glb being validated. */
  glb: { file: string; bytes: number; draco: boolean; ktx2: boolean };
  /** apps/web/public (tests pass a temp dir). */
  publicDir: string;
  /** Tier -> files, from checkTierTextures. */
  tiers: Map<string, LooseFile[]>;
  budget: number;
  /** Override for tests. */
  libsDir?: string;
}

export function firstLoad(input: FirstLoadInput): FirstLoad {
  const items: LoadItem[] = [{ file: input.glb.file, bytes: input.glb.bytes, what: "chicken" }];
  const lazy: LoadItem[] = [];
  let draco = input.glb.draco;
  let ktx2 = input.glb.ktx2;

  for (const [tier, files] of input.tiers) {
    for (const f of files) (tier === "rust" ? items : lazy).push({ ...f, what: `${tier} tier` });
    if (tier === "rust" && files.length) ktx2 = true;
  }
  const arena = join(input.publicDir, "models", "arena.glb");
  if (existsSync(arena)) {
    const used = readGlbJson(new Uint8Array(readFileSync(arena)))?.extensionsUsed ?? [];
    draco ||= used.includes("KHR_draco_mesh_compression");
    ktx2 ||= used.includes("KHR_texture_basisu");
    items.push(file(arena, "arena"));
  }
  const lightmap = join(input.publicDir, "models", "arena_lightmap.ktx2");
  if (existsSync(lightmap)) {
    items.push(file(lightmap, "arena lightmap"));
    ktx2 = true;
  }
  for (const path of listFiles(join(input.publicDir, "audio"))) items.push(file(path, "audio"));

  const libs = input.libsDir ?? threeLibsDir();
  const decoders = [...(draco ? DECODERS.draco.map((f) => [f, "Draco decoder"]) : []), ...(ktx2 ? DECODERS.basis.map((f) => [f, "Basis transcoder"]) : [])];
  for (const [f, what] of decoders) items.push({ ...file(join(libs, f!), what!), file: `decoders/${f!.replace("/gltf/", "/")}` });

  const total = items.reduce((s, i) => s + i.bytes, 0);
  return { items, lazy, total, budget: input.budget };
}

const MB = 1024 * 1024;
export const mb = (bytes: number): string => `${(bytes / MB).toFixed(2)} MB`;

/** The table as text lines. */
export function formatFirstLoad(f: FirstLoad): string[] {
  const width = Math.max(...f.items.map((i) => i.file.length), ...f.lazy.map((i) => i.file.length), 10);
  const row = (i: LoadItem) => `    ${i.file.padEnd(width)}  ${mb(i.bytes).padStart(9)}  ${i.what}`;
  const lines = [`  first load (raw bytes; budget ${mb(f.budget)}):`, ...f.items.map(row), `    ${"total".padEnd(width)}  ${mb(f.total).padStart(9)}  ${((100 * f.total) / f.budget).toFixed(0)}% of the budget`];
  if (f.lazy.length) lines.push("  lazy (not counted):", ...f.lazy.map(row));
  return lines;
}
