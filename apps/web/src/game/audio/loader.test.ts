import { afterEach, describe, expect, it, vi } from "vitest";
import { AudioEngine } from "./engine";
import { loadSounds, type LoaderDeps } from "./loader";
import type { Manifest } from "./manifest";
import { MockBuffer, MockContext } from "./mockAudio";
import { SOUND_NAMES, type SoundName } from "./names";
import { FIRST_HITS, RECIPES, RENDER_ORDER } from "./recipes";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function setup(manifest: Manifest | Promise<Manifest>, over: Partial<LoaderDeps> = {}) {
  const ctx = new MockContext();
  const engine = new AudioEngine(ctx as unknown as AudioContext);
  const rendered: SoundName[] = [];
  const fetched: string[] = [];
  const buf = () => new MockBuffer(1, 10, 44100) as unknown as AudioBuffer;
  let clock = 0;
  const deps: LoaderDeps = {
    manifest: () => Promise.resolve(manifest),
    recipes: async () => ({ RECIPES, RENDER_ORDER, FIRST_HITS }),
    render: async (name) => {
      rendered.push(name);
      await tick();
      clock += 5;
      return buf();
    },
    fetchFile: async (url) => {
      fetched.push(url);
      if (url.includes("broken")) throw new Error("HTTP 404");
      return new ArrayBuffer(8);
    },
    decode: async () => buf(),
    now: () => clock,
    manifestWaitMs: 0,
    concurrency: 3,
    ...over,
  };
  return { engine, deps, rendered, fetched };
}

describe("loadSounds", () => {
  afterEach(() => vi.restoreAllMocks());

  it("renders every recipe, in priority order, and logs the timing", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const { engine, deps, rendered } = setup({});
    await loadSounds(engine, deps);
    expect(engine.ready).toBe(SOUND_NAMES.length);
    expect(rendered).toEqual([...RENDER_ORDER]);
    for (const n of SOUND_NAMES) expect(engine.sourceOf(n)).toBe("recipe");
    expect(engine.firstHitsMs).toBeGreaterThanOrEqual(0);
    expect(engine.firstHitsMs).toBeLessThan(engine.readyMs);
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/30\/30 sounds ready in \d+ ms \(first hits \d+ ms/));
  });

  it("a listed file replaces the recipe, which is then never rendered", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { engine, deps, rendered, fetched } = setup({ hit_light: "hit_light.m4a", crowd_loop: "crowd.ogg" });
    await loadSounds(engine, deps);
    expect(engine.sourceOf("hit_light")).toBe("file");
    expect(engine.sourceOf("crowd_loop")).toBe("file");
    expect(rendered).not.toContain("hit_light");
    expect(rendered).not.toContain("crowd_loop");
    expect(fetched.sort()).toEqual(["/audio/crowd.ogg", "/audio/hit_light.m4a"]);
    expect(engine.ready).toBe(SOUND_NAMES.length);
  });

  it("a file that fails to load falls back to its recipe", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { engine, deps, rendered } = setup({ block: "broken.m4a" });
    await loadSounds(engine, deps);
    expect(engine.sourceOf("block")).toBe("recipe");
    expect(rendered.filter((n) => n === "block")).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("broken.m4a failed"));
  });

  it("a slow manifest doesn't hold up rendering; its file still wins when it lands", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    let release: (m: Manifest) => void = () => {};
    const late = new Promise<Manifest>((r) => (release = r));
    const { engine, deps } = setup(late);
    const done = loadSounds(engine, deps);
    await vi.waitFor(() => expect(engine.has("hit_light")).toBe(true));
    expect(engine.sourceOf("hit_light")).toBe("recipe");
    release({ hit_light: "hit_light.m4a" });
    await done;
    expect(engine.sourceOf("hit_light")).toBe("file");
  });

  it("stops quietly when the engine is disposed mid-load", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let release: (m: Manifest) => void = () => {};
    const late = new Promise<Manifest>((r) => (release = r));
    let open: () => void = () => {};
    const gate = new Promise<void>((r) => (open = r));
    const { engine, deps } = setup(late, {
      render: async () => {
        await gate;
        return new MockBuffer(1, 10, 44100) as unknown as AudioBuffer;
      },
    });
    const done = loadSounds(engine, deps);
    await tick();
    await tick();
    engine.dispose();
    open();
    // A file that lands (and fails) after dispose is not reported either.
    release({ hit_heavy: "broken.m4a" });
    await done;
    expect(engine.ready).toBe(0);
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
