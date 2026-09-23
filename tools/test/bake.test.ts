import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MOVE_NAMES, compileRules } from "@cockfight/sim";
import { CONTRACT, HITBOXES_JSON, PLACEHOLDER_GLB, fromRepo, sha256, type HitboxesFile } from "../src/assets/gltf";
import { checkHitboxes, diffHitboxes, formatHitboxes } from "../src/assets/bake";

const text = readFileSync(fromRepo(HITBOXES_JSON), "utf8");
const hb = JSON.parse(text) as HitboxesFile;
const tmp = mkdtempSync(join(tmpdir(), "cf-bake-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Placeholder design targets in mu (sim x = forward, y = up) for hit_beak while each attack is active. */
const ACTIVE: Record<string, { x: [number, number]; y: [number, number] }> = {
  peck: { x: [850, 1000], y: [750, 900] },
  shove: { x: [700, 800], y: [550, 650] },
  slam: { x: [800, 900], y: [100, 200] },
  super: { x: [900, 1000], y: [750, 850] },
  dive_kick: { x: [400, 500], y: [-100, 0] },
};
/**
 * A visual design check, not a gameplay guarantee: outside the active window
 * the beak stays back so wind-up and follow-through read clearly. What keeps
 * hits to active frames is the sim testing hit spheres only on active samples;
 * at pushbox contact (800 mu apart) even a beak at x <= 600 overlaps the other
 * chicken's hurt capsule.
 */
const VISUAL_RETRACTED_X = 600;

describe("hitboxes.json", () => {
  it("matches a fresh bake of its source glb (the bake --check path)", async () => {
    expect(await checkHitboxes()).toEqual({ ok: true, problems: [] });
  });

  it("tracks the committed placeholder by sha256", () => {
    expect(hb.source.file).toBe(PLACEHOLDER_GLB);
    expect(hb.source.sha256).toBe(sha256(new Uint8Array(readFileSync(fromRepo(PLACEHOLDER_GLB)))));
    expect({ v: hb.v, hz: hb.hz, units: hb.units, forward: hb.forward }).toEqual({ v: 1, hz: 60, units: 1000, forward: "+Z" });
  });

  it("is in canonical form: re-formatting it is a no-op", () => {
    expect(formatHitboxes(hb)).toBe(text);
  });

  it("has every contract clip with (n + 1) integer samples and no -0", () => {
    expect(Object.keys(hb.clips)).toEqual(CONTRACT.clips.map((c) => c.name));
    for (const c of CONTRACT.clips) {
      const clip = hb.clips[c.name]!;
      expect(clip.n, c.name).toBe(c.frames);
      expect(clip.hurt, c.name).toHaveLength((c.frames + 1) * 5);
      expect(clip.hit["hit_beak"], c.name).toHaveLength((c.frames + 1) * 3);
      for (const v of [...clip.hurt, ...clip.hit["hit_beak"]!]) {
        expect(Number.isSafeInteger(v) && !Object.is(v, -0), `${c.name}: ${v}`).toBe(true);
      }
    }
    expect(text).not.toMatch(/-0[,\]]/);
  });

  it("compiles in the sim with no move falling back to its static box", () => {
    const R = compileRules();
    expect(R.fallbacks).toEqual([]);
    for (let id = 1; id < MOVE_NAMES.length; id++) expect(R.clips[R.moves[id]!.clip]!.hit, MOVE_NAMES[id]).not.toBeNull();
  });

  it("rests with a vertical capsule standing on the ground, radii from the helpers", () => {
    expect(hb.clips["idle"]!.hurt.slice(0, 5)).toEqual([0, 400, 0, 1240, 400]);
    expect(hb.clips["idle"]!.hit["hit_beak"]!.slice(0, 3)).toEqual([550, 1110, 140]);
    for (const c of Object.values(hb.clips)) {
      for (let f = 0; f <= c.n; f++) {
        expect(c.hurt[f * 5 + 4]).toBe(400);
        expect(c.hit["hit_beak"]![f * 3 + 2]).toBe(140);
      }
    }
  });

  for (const [name, want] of Object.entries(ACTIVE)) {
    it(`${name}: the beak reaches its target while active and (visually) stays back otherwise`, () => {
      const clip = hb.clips[name]!;
      const [s, a] = CONTRACT.clips.find((c) => c.name === name)!.phases!;
      const beak = clip.hit["hit_beak"]!;
      for (let f = 0; f <= clip.n; f++) {
        const x = beak[f * 3]!;
        const y = beak[f * 3 + 1]!;
        if (f > s! && f <= s! + a!) {
          expect(x, `${name} active sample ${f} x`).toBeGreaterThanOrEqual(want.x[0]);
          expect(x, `${name} active sample ${f} x`).toBeLessThanOrEqual(want.x[1]);
          expect(y, `${name} active sample ${f} y`).toBeGreaterThanOrEqual(want.y[0]);
          expect(y, `${name} active sample ${f} y`).toBeLessThanOrEqual(want.y[1]);
        } else {
          expect(x, `${name} sample ${f} (startup/recovery, visual) x`).toBeLessThanOrEqual(VISUAL_RETRACTED_X);
        }
      }
    });
  }
});

describe("bake --check", () => {
  it("fails, naming the clip and sample, when one value drifts", async () => {
    const drifted = structuredClone(hb);
    drifted.clips["peck"]!.hit["hit_beak"]![5 * 3] = 901;
    const path = join(tmp, "drifted.json");
    writeFileSync(path, formatHitboxes(drifted));
    const r = await checkHitboxes(path);
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual(["clip peck hit_beak: first difference at sample 5 (901 -> 900)"]);
  });

  it("fails on a stale sha256 and on formatting-only changes", async () => {
    const stale = { ...hb, source: { ...hb.source, sha256: "f".repeat(64) } };
    expect(diffHitboxes(stale, hb)[0]).toContain("source sha256");
    const path = join(tmp, "pretty.json");
    writeFileSync(path, JSON.stringify(hb, null, 2));
    expect(await checkHitboxes(path)).toEqual({ ok: false, problems: ["formatting differs from a fresh bake"] });
  });

  it("fails clearly when the file was never baked", async () => {
    const path = join(tmp, "empty.json");
    writeFileSync(path, JSON.stringify({ v: 1, hz: 60, units: 1000, forward: "+Z", source: { file: "", sha256: "" }, clips: {} }));
    expect((await checkHitboxes(path)).problems[0]).toContain("never baked");
  });
});
