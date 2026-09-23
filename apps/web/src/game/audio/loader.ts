/**
 * Fills the engine with buffers: procedural recipes render in RENDER_ORDER a
 * few at a time, while manifest-listed files are fetched and decoded
 * alongside. A decoded file always wins; a file that fails falls back to its
 * recipe. Dependencies are injected so the policy is unit-tested in node.
 */
import type { AudioEngine } from "./engine";
import { fileUrl, loadManifest, type Manifest } from "./manifest";
import { SOUND_NAMES, type SoundName } from "./names";
import type { Recipe } from "./synth";

export interface RecipeBook {
  RECIPES: Record<SoundName, Recipe>;
  RENDER_ORDER: readonly SoundName[];
  FIRST_HITS: readonly SoundName[];
}

export interface LoaderDeps {
  manifest(): Promise<Manifest>;
  recipes(): Promise<RecipeBook>;
  render(name: SoundName, recipe: Recipe): Promise<AudioBuffer>;
  /** The file's bytes; throws on a failed response. */
  fetchFile(url: string): Promise<ArrayBuffer>;
  decode(data: ArrayBuffer): Promise<AudioBuffer>;
  now(): number;
  /**
   * How long rendering waits for the manifest before starting anyway. In the
   * usual case the manifest is in before the recipes chunk, so a listed
   * sound is never rendered just to be replaced.
   */
  manifestWaitMs: number;
  concurrency: number;
}

export function browserDeps(engine: AudioEngine): LoaderDeps {
  return {
    manifest: () => loadManifest(),
    recipes: () => import("./recipes"),
    render: async (name, recipe) => (await import("./offline")).renderRecipe(name, recipe),
    fetchFile: async (url) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.arrayBuffer();
    },
    decode: (data) => engine.ctx.decodeAudioData(data),
    now: () => performance.now(),
    manifestWaitMs: 250,
    concurrency: 3,
  };
}

export async function loadSounds(engine: AudioEngine, deps: LoaderDeps): Promise<void> {
  const t0 = deps.now();
  const manifest = deps.manifest();
  const early = new Promise<null>((res) => setTimeout(() => res(null), deps.manifestWaitMs));
  const [{ RECIPES, RENDER_ORDER, FIRST_HITS }, known] = await Promise.all([deps.recipes(), Promise.race([manifest, early])]);
  const fromFile = new Set<SoundName>(known ? (Object.keys(known) as SoundName[]) : []);
  /** Rendered or rendering: never render a sound twice (a failed file and the queue can both ask). */
  const claimed = new Set<SoundName>();
  const queue = RENDER_ORDER.slice();
  let renderMs = 0;

  const progress = () => {
    if (engine.firstHitsMs < 0 && FIRST_HITS.every((n) => engine.has(n))) engine.firstHitsMs = Math.round(deps.now() - t0);
  };

  const render = async (name: SoundName) => {
    if (claimed.has(name)) return;
    claimed.add(name);
    const t = deps.now();
    try {
      const buf = await deps.render(name, RECIPES[name]);
      // A decoded file may have landed while this rendered.
      if (!engine.has(name) && !engine.isDisposed) engine.setBuffer(name, buf, "recipe");
    } catch (e) {
      if (!engine.isDisposed) console.warn(`[cockfight] audio: recipe ${name} failed to render`, e);
    }
    renderMs += deps.now() - t;
    progress();
  };

  const worker = async () => {
    for (let name = queue.shift(); name && !engine.isDisposed; name = queue.shift()) {
      if (!fromFile.has(name) && !engine.has(name)) await render(name);
    }
  };

  const files = manifest.then((entries) =>
    Promise.all(
      (Object.entries(entries) as [SoundName, string][]).map(async ([name, file]) => {
        fromFile.add(name);
        try {
          const buf = await deps.decode(await deps.fetchFile(fileUrl(file)));
          if (engine.isDisposed) return;
          engine.setBuffer(name, buf, "file");
          progress();
        } catch (e) {
          if (engine.isDisposed) return; // decoding on a closed context fails; not the file's fault
          console.warn(`[cockfight] audio: ${file} failed (${String(e)}); using the procedural ${name}`);
          fromFile.delete(name);
          if (!engine.has(name)) await render(name);
        }
      }),
    ),
  );

  await Promise.all([...Array.from({ length: deps.concurrency }, worker), files]);
  if (engine.isDisposed) return;
  engine.readyMs = Math.round(deps.now() - t0);
  const fileCount = SOUND_NAMES.filter((n) => engine.sourceOf(n) === "file").length;
  console.info(
    `[cockfight] audio: ${engine.ready}/${SOUND_NAMES.length} sounds ready in ${engine.readyMs} ms ` +
      `(first hits ${engine.firstHitsMs} ms; ${engine.ready - fileCount} procedural, ${Math.round(renderMs)} ms of render work; ${fileCount} from files)`,
  );
}
