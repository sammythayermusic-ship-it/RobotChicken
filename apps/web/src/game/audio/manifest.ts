/**
 * Sound-file overrides. public/audio/manifest.json maps a SoundName to a file
 * next to it, e.g. {"hit_light": "hit_light.m4a"}; a listed file replaces the
 * procedural recipe. Only listed files are fetched (no 404 probing), and a
 * missing or broken manifest just means "all procedural".
 */
import { SOUND_NAMES, type SoundName } from "./names";

export const MANIFEST_URL = "/audio/manifest.json";

export type Manifest = Partial<Record<SoundName, string>>;

/** A plain file name in /audio/: no paths, no URLs, a browser-decodable extension. */
const FILE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*\.(m4a|aac|mp3|ogg|opus|webm|wav|flac)$/;

const KNOWN: ReadonlySet<string> = new Set(SOUND_NAMES);

export function parseManifest(json: unknown): { entries: Manifest; problems: string[] } {
  const entries: Manifest = {};
  const problems: string[] = [];
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return { entries, problems: ["manifest is not a JSON object"] };
  }
  for (const [key, value] of Object.entries(json)) {
    if (!KNOWN.has(key)) problems.push(`unknown sound "${key}"`);
    else if (typeof value !== "string" || !FILE.test(value) || value.includes("..")) problems.push(`bad file for "${key}": ${JSON.stringify(value)}`);
    else entries[key as SoundName] = value;
  }
  return { entries, problems };
}

export function fileUrl(file: string): string {
  return `/audio/${file}`;
}

/** Fetches and parses the manifest; any failure means no overrides. */
export async function loadManifest(fetchFn: typeof fetch = fetch): Promise<Manifest> {
  try {
    // Not content-hashed, so revalidate (a cheap 304) rather than trust a stale copy.
    const res = await fetchFn(MANIFEST_URL, { cache: "no-cache" });
    if (!res.ok) return {};
    const { entries, problems } = parseManifest(await res.json());
    if (problems.length) console.warn(`[cockfight] audio manifest: ${problems.join("; ")}`);
    return entries;
  } catch {
    return {};
  }
}
