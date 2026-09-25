/**
 * Texture rules, for textures inside a glb and for the tier texture sets the
 * game loads next to it. Everything skips cleanly when there are no textures
 * (the placeholder has none: flat materials).
 *
 * The rules: KTX2 only, Basis Universal inside (what KHR_texture_basisu and
 * three's KTX2Loader transcode), power-of-two sides no larger than the budget,
 * and the transfer function matching what the map holds. Color maps (base
 * color, emissive) are sRGB; data maps (normal, metal/rough, occlusion) are
 * linear, or three.js gamma-decodes the numbers.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { Document, Texture, TextureInfo } from "@gltf-transform/core";
import { toRepo } from "./gltf";
import { imageInfo, isPowerOfTwo, type Transfer } from "./images";
import type { Issue } from "./validate";

export type Slot = "baseColor" | "emissive" | "normal" | "metallicRoughness" | "occlusion";
const COLOR_SLOTS: ReadonlySet<Slot> = new Set(["baseColor", "emissive"]);

/** Tier ids, as in packages/shared TIERS (tools does not depend on shared). Only rust loads before the first fight. */
export const TIER_IDS = ["rust", "chrome", "gold", "diamond"] as const;
/** Under apps/web/public: textures/chicken/<tier>/<map>.ktx2. */
export const TIER_TEXTURE_DIR = "textures/chicken";
/** The four maps of a tier set and the transfer function each must use. */
export const TIER_MAPS: Readonly<Record<string, Transfer>> = { basecolor: "srgb", emissive: "srgb", orm: "linear", normal: "linear" };

type Push = (severity: Issue["severity"], message: string) => void;

interface ImageRules {
  label: string;
  bytes: Uint8Array | null;
  max: number;
  /** "srgb" or "linear" when the use is known. */
  expect?: Transfer;
  use?: string;
  normal?: boolean;
  /** The glTF mimeType, for embedded images whose header this module can't parse (WebP, ...). */
  mime?: string;
}

/** The size / format / transfer checks shared by embedded and loose textures. */
function checkImage(r: ImageRules, push: Push): void {
  const info = r.bytes ? imageInfo(r.bytes) : null;
  if (!info || info.format === "unknown") {
    const other = r.mime && r.mime !== "image/ktx2";
    push("error", other ? `${r.label} is ${r.mime}; the game ships KTX2 (Basis) textures: convert it with ktx create (docs/art-pipeline.md, Textures)` : `${r.label}: cannot read the image header`);
    return;
  }
  if (info.format !== "ktx2") {
    push("error", `${r.label} is ${info.format.toUpperCase()}; the game ships KTX2 (Basis) textures: convert it with ktx create (docs/art-pipeline.md, Textures)`);
  }
  if (info.width > r.max || info.height > r.max) push("error", `${r.label} is ${info.width}x${info.height}, over the ${r.max} limit`);
  if (!isPowerOfTwo(info.width) || !isPowerOfTwo(info.height)) {
    push("error", `${r.label} is ${info.width}x${info.height}; both sides must be powers of two (mipmaps and Basis blocks need them)`);
  }
  if (info.format !== "ktx2") return;
  if (info.model !== "etc1s" && info.model !== "uastc") {
    push("error", `${r.label} is KTX2 but not Basis Universal (ETC1S or UASTC), which KHR_texture_basisu and three's KTX2Loader need`);
  }
  if (r.expect === "srgb" && info.transfer !== "srgb") {
    push("error", `${r.label} holds color (${r.use}) but is encoded ${info.transfer ?? "?"}: re-encode it sRGB (ktx create --assign-tf srgb)`);
  } else if (r.expect === "linear" && info.transfer !== "linear") {
    push("error", `${r.label} holds data (${r.use}) but is encoded ${info.transfer ?? "?"}: re-encode it linear (ktx create --assign-tf linear), or three.js gamma-decodes the values`);
  }
  if (r.normal && info.model === "etc1s") push("warning", `${r.label} is a normal map in ETC1S; UASTC keeps normals clean`);
  if (r.normal && (info.channels === "rrrg" || info.channels === "rg" || info.channels === "rrr")) {
    push(
      "error",
      `${r.label} is a normal map stored as two channels (${info.channels.toUpperCase()}, what ktx create --normal-mode writes), ` +
        "but three.js normalMap reads RGB = XYZ: re-encode it as RGB without --normal-mode (pnpm textures)",
    );
  }
  if (info.model === "uastc" && info.supercompression === "none") {
    push("warning", `${r.label} is UASTC without supercompression, several times larger than it needs to be: re-encode it with --zstd 18 (pnpm textures)`);
  }
}

/**
 * Rules for the textures embedded in a glb. A texture read through
 * TEXCOORD_1 is a lightmap (arena) and may be up to `lightmapMax`.
 */
export function checkDocumentTextures(doc: Document, opts: { maxSize: number; lightmapMax?: number }): { issues: Issue[]; count: number } {
  const issues: Issue[] = [];
  const push: Push = (severity, message) => issues.push({ severity, code: "textures", message });
  const root = doc.getRoot();
  const textures = root.listTextures();
  if (textures.length === 0) return { issues, count: 0 };

  const uses = new Map<Texture, { slots: Set<Slot>; texCoords: Set<number> }>();
  const note = (tex: Texture | null, info: TextureInfo | null, slot: Slot) => {
    if (!tex) return;
    const u = uses.get(tex) ?? { slots: new Set<Slot>(), texCoords: new Set<number>() };
    u.slots.add(slot);
    u.texCoords.add(info?.getTexCoord() ?? 0);
    uses.set(tex, u);
  };
  for (const m of root.listMaterials()) {
    note(m.getBaseColorTexture(), m.getBaseColorTextureInfo(), "baseColor");
    note(m.getEmissiveTexture(), m.getEmissiveTextureInfo(), "emissive");
    note(m.getNormalTexture(), m.getNormalTextureInfo(), "normal");
    note(m.getMetallicRoughnessTexture(), m.getMetallicRoughnessTextureInfo(), "metallicRoughness");
    note(m.getOcclusionTexture(), m.getOcclusionTextureInfo(), "occlusion");
  }

  let ktx2 = 0;
  textures.forEach((tex, i) => {
    const label = `texture "${tex.getName() || tex.getURI() || `#${i}`}"`;
    const u = uses.get(tex);
    const slots = [...(u?.slots ?? [])];
    const color = slots.filter((s) => COLOR_SLOTS.has(s));
    const data = slots.filter((s) => !COLOR_SLOTS.has(s));
    if (tex.getMimeType() === "image/ktx2") ktx2++;
    if (!u) push("warning", `${label} is not used by any material`);
    if (color.length && data.length) {
      push("error", `${label} is used for color (${color.join(", ")}) and data (${data.join(", ")}); color maps are sRGB and data maps linear, so they need separate files`);
    }
    const lightmap = u?.texCoords.has(1) ?? false;
    checkImage(
      {
        label,
        bytes: tex.getImage(),
        max: lightmap ? (opts.lightmapMax ?? opts.maxSize) : opts.maxSize,
        expect: color.length && !data.length ? "srgb" : data.length && !color.length ? "linear" : undefined,
        use: slots.join(", "),
        normal: slots.includes("normal"),
        mime: tex.getMimeType(),
      },
      push,
    );
  });
  const used = root.listExtensionsUsed().map((e) => e.extensionName);
  if (ktx2 > 0 && !used.includes("KHR_texture_basisu")) {
    push("error", `${ktx2} KTX2 texture(s) but KHR_texture_basisu is not declared; three's GLTFLoader only loads KTX2 through it`);
  }
  return { issues, count: textures.length };
}

export interface LooseFile {
  /** Repo-relative (or absolute) path. */
  file: string;
  bytes: number;
}

/** Files directly inside `dir` (no recursion), sorted; [] when the directory does not exist. */
export function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => !f.startsWith(".") && statSync(join(dir, f)).isFile())
    .sort()
    .map((f) => join(dir, f));
}

/**
 * Rules for the tier sets in <publicDir>/textures/chicken/<tier>/<map>.ktx2.
 * Returns the files per tier for the first-load table. Skips (no issues) when
 * the folder does not exist.
 */
export function checkTierTextures(publicDir: string, maxSize: number): { issues: Issue[]; tiers: Map<string, LooseFile[]> } {
  const issues: Issue[] = [];
  const push: Push = (severity, message) => issues.push({ severity, code: "tier-textures", message });
  const tiers = new Map<string, LooseFile[]>();
  const root = join(publicDir, ...TIER_TEXTURE_DIR.split("/"));
  if (!existsSync(root)) return { issues, tiers };
  for (const tier of readdirSync(root).sort()) {
    const dir = join(root, tier);
    if (tier.startsWith(".") || !statSync(dir).isDirectory()) continue;
    if (!(TIER_IDS as readonly string[]).includes(tier)) push("warning", `${toRepo(dir)}: "${tier}" is not a tier (${TIER_IDS.join(", ")})`);
    const files: LooseFile[] = [];
    for (const path of listFiles(dir)) {
      const bytes = new Uint8Array(readFileSync(path));
      files.push({ file: toRepo(path), bytes: bytes.length });
      const map = basename(path, extname(path));
      const expect = TIER_MAPS[map];
      if (!expect) push("warning", `${toRepo(path)}: unknown map "${map}" (expected ${Object.keys(TIER_MAPS).join(", ")})`);
      checkImage({ label: toRepo(path), bytes, max: maxSize, expect, use: map, normal: map === "normal" }, push);
    }
    tiers.set(tier, files);
  }
  return { issues, tiers };
}
