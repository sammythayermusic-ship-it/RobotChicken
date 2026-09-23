/**
 * Shared plumbing for the asset tools: the chicken contract, one NodeIO that
 * can read (and re-write) Draco glbs, repo-relative paths and hashing.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { NodeIO, type Document } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco3d from "draco3dgltf";
import contractJson from "@cockfight/sim/data/chicken.contract.json" with { type: "json" };
import movesJson from "@cockfight/sim/data/moves.json" with { type: "json" };
import { REPO_ROOT, repoPath } from "../root";

export interface ContractClip {
  name: string;
  frames: number;
  loop: boolean;
  /** [startup, active, recovery] for attacks; sample f is active when startup < f <= startup + active. */
  phases?: number[];
}

export interface ContractHelper {
  shape: "capsule" | "sphere";
  bone: string;
  radius: number;
  halfHeight?: number;
}

export interface Contract {
  fps: number;
  units: number;
  rig: { armature: string; rootBone: string };
  clips: ContractClip[];
  helpers: Record<string, ContractHelper>;
  materials: string[];
  budgets: {
    chickenTriangles: number;
    joints: number;
    /** Largest chicken texture side (px). */
    textureSize: number;
    arenaTriangles: number;
    /** Largest arena lightmap side (px). */
    lightmapSize: number;
    /** Everything fetched before the first fight, raw bytes. */
    firstLoadBytes: number;
  };
}

/** packages/sim/data/chicken.contract.json: the single source of truth for clips, helpers, slots and budgets. */
export const CONTRACT = contractJson as Contract;

/** The parts of packages/sim/data/moves.json the asset tools read. Move names are clip names (rules.ts moveClip). */
export interface MovesFile {
  moves: Record<string, { startup: number; active: number; recovery: number; hitNode?: string }>;
}

export const MOVES = movesJson as MovesFile;

/** Repo-relative (posix) paths. */
export const PLACEHOLDER_GLB = "apps/web/public/models/chicken_placeholder.glb";
/** Where `pnpm assets:import` writes the hero chicken by default. */
export const HERO_GLB = "apps/web/public/models/chicken.glb";
export const HITBOXES_JSON = "packages/sim/data/hitboxes.json";
export const PLACEHOLDER_SCRIPT = "art/blender/build_placeholder_chicken.py";
export const EXPORT_SCRIPT = "art/blender/export_chicken.py";
/** The web app's static root: a glb must live under it for the game to load it. */
export const PUBLIC_DIR = "apps/web/public";
/** Sammy's arena, when it exists (the procedural junkyard needs no files), and its baked lightmap. */
export const ARENA_GLB = "apps/web/public/models/arena.glb";
export const ARENA_LIGHTMAP = "apps/web/public/models/arena_lightmap.ktx2";

/** The shape of packages/sim/data/hitboxes.json (what packages/sim/src/rules.ts compileRules reads). */
export interface ClipBoxes {
  n: number;
  /** (n + 1) x [ax, ay, bx, by, r] in mu: the hurt capsule's axis endpoints and radius. */
  hurt: number[];
  /** helper name -> (n + 1) x [x, y, r] in mu. */
  hit: Record<string, number[]>;
}

export interface HitboxesFile {
  v: number;
  hz: number;
  units: number;
  forward: string;
  source: { file: string; sha256: string };
  clips: Record<string, ClipBoxes>;
}

let io: Promise<NodeIO> | null = null;

/** A NodeIO with every extension and both Draco codecs (the encoder lets tests write mutated copies). */
export function getIO(): Promise<NodeIO> {
  io ??= (async () =>
    new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
      "draco3d.decoder": await draco3d.createDecoderModule(),
      "draco3d.encoder": await draco3d.createEncoderModule(),
    }))();
  return io;
}

export async function readGlb(bytes: Uint8Array): Promise<Document> {
  return (await getIO()).readBinary(bytes);
}

/** The JSON chunk of a GLB, without decoding anything (null if it is not a GLB). */
export function readGlbJson(bytes: Uint8Array): { extensionsUsed?: string[]; asset?: { generator?: string } } | null {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== 0x46546c67) return null; // "glTF"
    return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + view.getUint32(12, true)))) as { extensionsUsed?: string[] };
  } catch {
    return null;
  }
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Absolute path of a repo-relative path. */
export const fromRepo = (p: string): string => (isAbsolute(p) ? p : repoPath(...p.split("/")));

/** Repo-relative posix path (what hitboxes.json stores), or the absolute path if outside the repo. */
export function toRepo(abs: string): string {
  const rel = relative(REPO_ROOT, abs);
  return rel.startsWith("..") || isAbsolute(rel) ? abs : rel.split(sep).join("/");
}

/**
 * The directory the user ran the command from. pnpm runs package scripts in
 * tools/ and sets INIT_CWD to where pnpm was invoked, which is the user's
 * directory for `pnpm --filter @cockfight/tools run ...`. The root wrappers
 * (`pnpm assets:validate` etc.) start a second pnpm from the repo root, which
 * resets INIT_CWD to the root, so they pass the user's directory on as CF_CWD.
 * Empty values are skipped (a wrapper run where INIT_CWD was unset).
 */
export function userCwd(env: NodeJS.ProcessEnv = process.env): string {
  return env.CF_CWD || env.INIT_CWD || process.cwd();
}

/** Resolve a path typed on the command line against the user's directory (see userCwd). */
export function userPath(p: string, env: NodeJS.ProcessEnv = process.env): string {
  return resolve(userCwd(env), p);
}

export function readHitboxes(path = fromRepo(HITBOXES_JSON)): HitboxesFile {
  return JSON.parse(readFileSync(path, "utf8")) as HitboxesFile;
}

/** The glb the pipeline currently tracks: hitboxes.json's source, else the placeholder. */
export function trackedGlb(hitboxes: HitboxesFile | null = readHitboxes()): string {
  return fromRepo(hitboxes?.source.file || PLACEHOLDER_GLB);
}
