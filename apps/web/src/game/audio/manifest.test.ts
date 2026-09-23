import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { MANIFEST_URL, fileUrl, loadManifest, parseManifest } from "./manifest";

describe("audio manifest", () => {
  it("accepts known sounds with plain audio file names", () => {
    const { entries, problems } = parseManifest({ hit_light: "hit_light.m4a", ko_horn: "horn-v2.mp3", crowd_loop: "crowd.ogg" });
    expect(entries).toEqual({ hit_light: "hit_light.m4a", ko_horn: "horn-v2.mp3", crowd_loop: "crowd.ogg" });
    expect(problems).toEqual([]);
    expect(fileUrl("hit_light.m4a")).toBe("/audio/hit_light.m4a");
  });

  it("skips unknown names and unsafe or non-audio files, keeping the rest", () => {
    const { entries, problems } = parseManifest({
      hit_light: "ok.m4a",
      hit_lite: "typo.m4a",
      hit_heavy: "../secret.m4a",
      hit_slam: "https://evil.example/x.m4a",
      block: "sub/dir.m4a",
      dash: "notes.txt",
      jump: 42,
      land: "",
    });
    expect(entries).toEqual({ hit_light: "ok.m4a" });
    expect(problems).toHaveLength(7);
  });

  it("rejects a manifest that is not an object", () => {
    for (const bad of [null, [], "x", 3]) {
      const { entries, problems } = parseManifest(bad);
      expect(entries).toEqual({});
      expect(problems).toHaveLength(1);
    }
  });

  it("the shipped manifest is valid (and empty until the sound pack lands)", () => {
    const json: unknown = JSON.parse(readFileSync(new URL("../../../public/audio/manifest.json", import.meta.url), "utf8"));
    expect(parseManifest(json).problems).toEqual([]);
  });

  it("loadManifest: fetched entries, or nothing on 404 / network error / bad JSON", async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify({ round_bell: "bell.m4a" }), { status: 200 }));
    expect(await loadManifest(ok as unknown as typeof fetch)).toEqual({ round_bell: "bell.m4a" });
    expect(ok).toHaveBeenCalledWith(MANIFEST_URL, expect.objectContaining({ cache: "no-cache" }));

    const missing = async () => new Response("nope", { status: 404 });
    expect(await loadManifest(missing as unknown as typeof fetch)).toEqual({});
    const offline = async () => {
      throw new TypeError("Failed to fetch");
    };
    expect(await loadManifest(offline as unknown as typeof fetch)).toEqual({});
    const garbage = async () => new Response("{not json", { status: 200 });
    expect(await loadManifest(garbage as unknown as typeof fetch)).toEqual({});
  });

  it("loadManifest warns once about bad entries but keeps the good ones", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = async () => new Response(JSON.stringify({ hit_light: "a.m4a", nope: "b.m4a" }), { status: 200 });
    expect(await loadManifest(res as unknown as typeof fetch)).toEqual({ hit_light: "a.m4a" });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
