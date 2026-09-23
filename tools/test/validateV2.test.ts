/**
 * validate v2 rules against the committed placeholder and in-memory mutated
 * copies (no Blender): moves.json clips in the glb and hitboxes.json, attacks
 * reaching forward and above the floor while active, texture rules, the tier
 * texture sets, animation byte sizes and the first-load table.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Document, Material } from "@gltf-transform/core";
import { KHRTextureBasisu } from "@gltf-transform/extensions";
import { CONTRACT, MOVES, PLACEHOLDER_GLB, fromRepo, readGlb, readHitboxes, type Contract } from "../src/assets/gltf";
import { imageInfo } from "../src/assets/images";
import { checkHitboxesForMoves, formatReport, validateDocument, validateFile, validateGlb, type Issue } from "../src/assets/validate";
import { fakeKtx2, fakePng } from "./helpers/images";

const glbPath = fromRepo(PLACEHOLDER_GLB);
const bytes = new Uint8Array(readFileSync(glbPath));
const tmp = mkdtempSync(join(tmpdir(), "cf-validate2-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const errors = (issues: Issue[]) => issues.filter((i) => i.severity === "error");
const anim = (doc: Document, name: string) => doc.getRoot().listAnimations().find((a) => a.getName() === name)!;
const material = (doc: Document, name: string) => doc.getRoot().listMaterials().find((m) => m.getName() === name)!;

/** Shift one per-frame channel's keys at the given samples: out[f*3 + axis] += delta. */
function nudge(doc: Document, clip: string, node: string, samples: number[], axis: number, delta: number): void {
  const ch = anim(doc, clip)
    .listChannels()
    .find((c) => c.getTargetNode()?.getName() === node && c.getTargetPath() === "translation")!;
  const out = ch.getSampler()!.getOutput()!;
  const moved = Float32Array.from(out.getArray() as Float32Array);
  expect(moved.length, "a per-frame LINEAR channel").toBe((CONTRACT.clips.find((c) => c.name === clip)!.frames + 1) * 3);
  for (const f of samples) moved[f * 3 + axis] = moved[f * 3 + axis]! + delta;
  out.setArray(moved);
}

describe("validate v2: the committed placeholder", () => {
  it("passes, with per-clip animation bytes and a first-load table under 12 MB", async () => {
    const r = await validateFile(glbPath, { hitboxes: readHitboxes(), file: PLACEHOLDER_GLB });
    expect(r.issues).toEqual([]);
    expect(r.stats.textures).toBe(0);

    const clipBytes = r.stats.clipBytes!;
    expect(Object.keys(clipBytes).sort()).toEqual(CONTRACT.clips.map((c) => c.name).sort());
    const sum = Object.values(clipBytes).reduce((a, b) => a + b, 0);
    expect(r.stats.animationBytes).toBeGreaterThan(0);
    expect(r.stats.animationBytes).toBeLessThanOrEqual(sum); // shared time accessors count once in the total
    expect(r.stats.jsonBytes).toBeGreaterThan(0);

    const load = r.firstLoad!;
    expect(load.budget).toBe(12 * 1024 * 1024);
    expect(load.items.map((i) => [i.file, i.what])).toEqual([
      [PLACEHOLDER_GLB, "chicken"],
      // The sound-pack override manifest (fetched when the fight starts; empty until Sammy's pack lands).
      ["apps/web/public/audio/manifest.json", "audio"],
      ["decoders/draco/draco_wasm_wrapper.js", "Draco decoder"],
      ["decoders/draco/draco_decoder.wasm", "Draco decoder"],
    ]);
    expect(load.items[0]!.bytes).toBe(bytes.length);
    expect(load.total).toBe(load.items.reduce((s, i) => s + i.bytes, 0));
    expect(load.total).toBeLessThan(load.budget);
    expect(load.lazy).toEqual([]);

    const text = formatReport(r);
    expect(text).toContain("first load (raw bytes; budget 12.00 MB)");
    expect(text).toContain("textures: none embedded (texture rules skipped)");
    expect(text).toMatch(/animations: [\d.]+ KB of keyframe data/);
  });

  it("checks every moves.json attack on its active samples", async () => {
    // The rule runs on the placeholder (and passes): reaching the peck's beak back into the body trips it.
    const doc = await readGlb(bytes);
    expect(errors(validateDocument(doc).issues)).toEqual([]);
    expect(Object.keys(MOVES.moves).sort()).toEqual(["dive_kick", "peck", "shove", "slam", "super"]);
  });
});

describe("attacks must reach while active", () => {
  it("a hit helper behind the body during active frames fails, naming the clip and samples", async () => {
    const doc = await readGlb(bytes);
    nudge(doc, "peck", "head", [5, 6], 2, -2.0); // head (and beak) pulled back 2 units on peck's active samples only
    const errs = errors(validateDocument(doc).issues);
    expect(errs.map((e) => e.code)).toEqual(["active"]);
    expect(errs[0]!.message).toMatch(/^clip "peck" active samples 5-6: "hit_beak" is not in front of "hurt_body"'s center at sample 5 \(x -?[\d.]+ vs [\d.-]+\), 6 /);
  });

  it("a hit helper entirely below the floor during active frames fails", async () => {
    const doc = await readGlb(bytes);
    nudge(doc, "slam", "body", [15, 16, 17, 18], 1, -3.0); // the whole chicken sinks 3 units while the slam is active
    const errs = errors(validateDocument(doc).issues);
    expect(errs.map((e) => e.code)).toEqual(["active"]);
    expect(errs[0]!.message).toContain('clip "slam" active samples 15-18: "hit_beak" is entirely below the floor at sample 15');
  });

  it("uses the move's hitNode from moves.json", async () => {
    const doc = await readGlb(bytes);
    const moves = { moves: { ...MOVES.moves, peck: { ...MOVES.moves["peck"]!, hitNode: "hit_claw" } } };
    const errs = errors(validateDocument(doc, CONTRACT, moves).issues);
    expect(errs.map((e) => e.message)).toEqual(['moves.json peck.hitNode "hit_claw" is not a sphere helper in the glb (an empty with cf_shape = "sphere")']);
  });
});

describe("moves.json clips", () => {
  it("a clip moves.json plays that is missing from the glb fails, saying which move needs it", async () => {
    const doc = await readGlb(bytes);
    anim(doc, "slam").setName("slam_old");
    const msgs = errors(validateDocument(doc).issues).map((e) => e.message);
    expect(msgs).toContain('missing clip "slam"; moves.json move "slam" plays it');
  });

  it("a move with no contract clip fails", async () => {
    const doc = await readGlb(bytes);
    const moves = { moves: { ...MOVES.moves, headbutt: { startup: 3, active: 2, recovery: 9 } } };
    expect(errors(validateDocument(doc, CONTRACT, moves).issues).map((e) => [e.code, e.message])).toEqual([
      ["moves", 'moves.json move "headbutt" has no clip "headbutt" in chicken.contract.json (a move plays the clip of its own name)'],
    ]);
  });

  it("hitboxes.json missing a moves.json clip (or its hit table) fails", async () => {
    const hb = readHitboxes();
    expect(checkHitboxesForMoves(hb)).toEqual([]);
    const { slam: _slam, ...rest } = hb.clips;
    const noSlam = { ...hb, clips: rest };
    expect(checkHitboxesForMoves(noSlam).map((i) => i.message)).toEqual([
      'packages/sim/data/hitboxes.json has no clip "slam" (moves.json move "slam"): run pnpm assets:bake',
    ]);
    const noTable = structuredClone(hb);
    noTable.clips["peck"]!.hit = {};
    expect(checkHitboxesForMoves(noTable)[0]!.message).toContain('clip "peck" has no "hit_beak" table');
    const r = await validateGlb(bytes, { file: PLACEHOLDER_GLB, hitboxes: noSlam, publicDir: null });
    expect(errors(r.issues).map((e) => e.code)).toEqual(["hitboxes"]);
  });
});

describe("texture rules", () => {
  function withTexture(doc: Document, image: Uint8Array, mime: string, set: (m: Material, t: ReturnType<Document["createTexture"]>) => void) {
    const tex = doc.createTexture("shell_map").setImage(image).setMimeType(mime);
    set(material(doc, "cf_shell"), tex);
    return tex;
  }
  const basisu = (doc: Document) => doc.createExtension(KHRTextureBasisu);
  const textureIssues = (doc: Document) => validateDocument(doc).issues.filter((i) => i.code === "textures");

  it("skip cleanly when there are no textures", async () => {
    const doc = await readGlb(bytes);
    const r = validateDocument(doc);
    expect(r.stats.textures).toBe(0);
    expect(r.issues.filter((i) => i.code === "textures")).toEqual([]);
  });

  it("accept a 2048 sRGB Basis base color map", async () => {
    const doc = await readGlb(bytes);
    basisu(doc);
    withTexture(doc, fakeKtx2({ width: 2048 }), "image/ktx2", (m, t) => m.setBaseColorTexture(t));
    expect(textureIssues(doc)).toEqual([]);
    expect(validateDocument(doc).stats.textures).toBe(1);
  });

  it("an oversized texture fails", async () => {
    const doc = await readGlb(bytes);
    basisu(doc);
    withTexture(doc, fakeKtx2({ width: 4096 }), "image/ktx2", (m, t) => m.setBaseColorTexture(t));
    expect(textureIssues(doc).map((i) => i.message)).toEqual(['texture "shell_map" is 4096x4096, over the 2048 limit']);
  });

  it("a non-power-of-two texture fails", async () => {
    const doc = await readGlb(bytes);
    basisu(doc);
    withTexture(doc, fakeKtx2({ width: 1000, height: 1024 }), "image/ktx2", (m, t) => m.setBaseColorTexture(t));
    expect(textureIssues(doc).map((i) => i.message)).toEqual([
      'texture "shell_map" is 1000x1024; both sides must be powers of two (mipmaps and Basis blocks need them)',
    ]);
  });

  it("a PNG fails: textures ship as KTX2", async () => {
    const doc = await readGlb(bytes);
    withTexture(doc, fakePng(1024), "image/png", (m, t) => m.setBaseColorTexture(t));
    expect(textureIssues(doc).map((i) => i.message)).toEqual([
      'texture "shell_map" is PNG; the game ships KTX2 (Basis) textures: convert it with ktx create (docs/art-pipeline.md, Textures)',
    ]);
  });

  it("color maps must be sRGB and data maps linear", async () => {
    const linearColor = await readGlb(bytes);
    basisu(linearColor);
    withTexture(linearColor, fakeKtx2({ width: 1024, transfer: "linear" }), "image/ktx2", (m, t) => m.setBaseColorTexture(t));
    expect(textureIssues(linearColor)[0]!.message).toContain("holds color (baseColor) but is encoded linear");

    const srgbNormal = await readGlb(bytes);
    basisu(srgbNormal);
    withTexture(srgbNormal, fakeKtx2({ width: 1024, transfer: "srgb", model: "uastc" }), "image/ktx2", (m, t) => m.setNormalTexture(t));
    expect(textureIssues(srgbNormal)[0]!.message).toContain("holds data (normal) but is encoded srgb");

    const shared = await readGlb(bytes);
    basisu(shared);
    withTexture(shared, fakeKtx2({ width: 1024 }), "image/ktx2", (m, t) => m.setBaseColorTexture(t).setOcclusionTexture(t));
    expect(textureIssues(shared)[0]!.message).toContain("is used for color (baseColor) and data (occlusion)");
  });

  it("an ETC1S normal map is a warning; KTX2 without KHR_texture_basisu is an error", async () => {
    const etc1sNormal = await readGlb(bytes);
    basisu(etc1sNormal);
    withTexture(etc1sNormal, fakeKtx2({ width: 1024, transfer: "linear", model: "etc1s" }), "image/ktx2", (m, t) => m.setNormalTexture(t));
    expect(textureIssues(etc1sNormal).map((i) => [i.severity, i.message])).toEqual([
      ["warning", 'texture "shell_map" is a normal map in ETC1S; UASTC keeps normals clean'],
    ]);

    const noExt = await readGlb(bytes);
    withTexture(noExt, fakeKtx2({ width: 1024 }), "image/ktx2", (m, t) => m.setBaseColorTexture(t));
    expect(textureIssues(noExt).map((i) => i.message)).toEqual([
      "1 KTX2 texture(s) but KHR_texture_basisu is not declared; three's GLTFLoader only loads KTX2 through it",
    ]);
  });

  it("a normal map in the two-channel --normal-mode layout fails: three.js reads RGB = XYZ", async () => {
    // UASTC --normal-mode writes one RRRG sample; ETC1S writes two slices, RRR and GGG (KTX-Software 4.4 basis_encode.cpp).
    for (const [model, channels, name] of [
      ["uastc", [5], "RRRG"],
      ["etc1s", [3, 4], "RRRG"],
      ["uastc", [6], "RG"],
    ] as const) {
      const doc = await readGlb(bytes);
      basisu(doc);
      withTexture(doc, fakeKtx2({ width: 1024, transfer: "linear", model, channels: [...channels] }), "image/ktx2", (m, t) => m.setNormalTexture(t));
      expect(errors(textureIssues(doc)).map((i) => i.message)).toEqual([
        `texture "shell_map" is a normal map stored as two channels (${name}, what ktx create --normal-mode writes), but three.js normalMap reads RGB = XYZ: re-encode it as RGB without --normal-mode (pnpm textures)`,
      ]);
    }
    // The same layout is fine for a map that is not a normal map, and RGB normals pass.
    const orm = await readGlb(bytes);
    basisu(orm);
    withTexture(orm, fakeKtx2({ width: 1024, transfer: "linear", model: "uastc", channels: [5] }), "image/ktx2", (m, t) => m.setOcclusionTexture(t));
    expect(textureIssues(orm)).toEqual([]);
    const rgb = await readGlb(bytes);
    basisu(rgb);
    withTexture(rgb, fakeKtx2({ width: 1024, transfer: "linear", model: "uastc" }), "image/ktx2", (m, t) => m.setNormalTexture(t));
    expect(textureIssues(rgb)).toEqual([]);
  });

  it("UASTC without Zstandard supercompression is a warning", async () => {
    const doc = await readGlb(bytes);
    basisu(doc);
    withTexture(doc, fakeKtx2({ width: 1024, transfer: "linear", model: "uastc", supercompression: 0 }), "image/ktx2", (m, t) => m.setNormalTexture(t));
    expect(textureIssues(doc).map((i) => [i.severity, i.message])).toEqual([
      ["warning", 'texture "shell_map" is UASTC without supercompression, several times larger than it needs to be: re-encode it with --zstd 18 (pnpm textures)'],
    ]);
  });

  it("reads KTX2, PNG and JPEG headers", () => {
    expect(imageInfo(fakeKtx2({ width: 512, height: 256, transfer: "linear", model: "uastc" }))).toEqual({
      format: "ktx2",
      width: 512,
      height: 256,
      levels: 1,
      model: "uastc",
      transfer: "linear",
      supercompression: "zstd",
      channels: "rgb",
    });
    expect(imageInfo(fakeKtx2({ width: 64, model: "etc1s", channels: [0, 15] }))).toMatchObject({ supercompression: "basislz", channels: "rgba" });
    expect(imageInfo(fakeKtx2({ width: 64, model: "uastc", channels: [5], supercompression: 0 }))).toMatchObject({ supercompression: "none", channels: "rrrg" });
    expect(imageInfo(fakePng(300, 200))).toEqual({ format: "png", width: 300, height: 200 });
    // SOI, an APP0 segment of length 4, then SOF0 with height 0x0100 and width 0x0200.
    const jpeg = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x00, 0x02, 0x00, 0x03);
    expect(imageInfo(jpeg)).toEqual({ format: "jpeg", width: 512, height: 256 });
    expect(imageInfo(Uint8Array.of(1, 2, 3))).toEqual({ format: "unknown", width: 0, height: 0 });
  });
});

describe("tier textures and the first-load table", () => {
  let n = 0;
  /** A temp apps/web/public with the given files (path -> bytes). */
  function publicDir(files: Record<string, Uint8Array>): string {
    const dir = join(tmp, `public${n++}`);
    for (const [path, data] of Object.entries(files)) {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), data);
    }
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  it("count Rust (and the Basis transcoder) on first load, other tiers as lazy", async () => {
    const dir = publicDir({
      "textures/chicken/rust/basecolor.ktx2": fakeKtx2({ width: 2048 }),
      "textures/chicken/rust/orm.ktx2": fakeKtx2({ width: 2048, transfer: "linear", model: "uastc" }),
      "textures/chicken/gold/basecolor.ktx2": fakeKtx2({ width: 2048 }),
    });
    const r = await validateGlb(bytes, { file: PLACEHOLDER_GLB, hitboxes: null, publicDir: dir });
    expect(r.issues).toEqual([]);
    const load = r.firstLoad!;
    expect(load.items.map((i) => i.what)).toEqual(["chicken", "rust tier", "rust tier", "Draco decoder", "Draco decoder", "Basis transcoder", "Basis transcoder"]);
    expect(load.items.map((i) => i.file)).toContain("decoders/basis/basis_transcoder.wasm");
    expect(load.lazy.map((i) => i.what)).toEqual(["gold tier"]);
  });

  it("apply the texture rules to tier files", async () => {
    const dir = publicDir({
      "textures/chicken/rust/basecolor.png": fakePng(2048),
      "textures/chicken/rust/normal.ktx2": fakeKtx2({ width: 4096, transfer: "srgb", model: "uastc" }),
      "textures/chicken/chrome/orm.ktx2": fakeKtx2({ width: 1024, transfer: "linear", model: "uastc" }),
    });
    const r = await validateGlb(bytes, { file: PLACEHOLDER_GLB, hitboxes: null, publicDir: dir });
    const msgs = errors(r.issues).map((e) => `[${e.code}] ${e.message.replace(dir, "<public>")}`);
    expect(msgs).toEqual([
      "[tier-textures] <public>/textures/chicken/rust/basecolor.png is PNG; the game ships KTX2 (Basis) textures: convert it with ktx create (docs/art-pipeline.md, Textures)",
      "[tier-textures] <public>/textures/chicken/rust/normal.ktx2 is 4096x4096, over the 2048 limit",
      "[tier-textures] <public>/textures/chicken/rust/normal.ktx2 holds data (normal) but is encoded srgb: re-encode it linear (ktx create --assign-tf linear), or three.js gamma-decodes the values",
    ]);
  });

  it("fail when the first load goes over budget", async () => {
    const small: Contract = { ...CONTRACT, budgets: { ...CONTRACT.budgets, firstLoadBytes: 100_000 } };
    const r = await validateGlb(bytes, { file: PLACEHOLDER_GLB, hitboxes: null, contract: small, publicDir: publicDir({}) });
    const errs = errors(r.issues);
    expect(errs.map((e) => e.code)).toEqual(["first-load"]);
    expect(errs[0]!.message).toMatch(/^the first load is 0\.\d\d MB, over the 0\.10 MB budget/);
  });

  it("count Sammy's arena, its lightmap and audio overrides when they exist", async () => {
    const dir = publicDir({
      "models/arena.glb": bytes, // any Draco glb stands in for the arena here
      "models/arena_lightmap.ktx2": fakeKtx2({ width: 4096 }),
      "audio/bell.m4a": new Uint8Array(1234),
    });
    const r = await validateGlb(bytes, { file: PLACEHOLDER_GLB, hitboxes: null, publicDir: dir });
    const whats = r.firstLoad!.items.map((i) => i.what);
    expect(whats).toEqual(["chicken", "arena", "arena lightmap", "audio", "Draco decoder", "Draco decoder", "Basis transcoder", "Basis transcoder"]);
  });
});
