/**
 * An independent oracle for the bake: three.js (the runtime that draws the
 * chicken) loads the glb with GLTFLoader and poses it with AnimationMixer the
 * way the game must: action.time = Math.fround(f / 60); mixer.update(0). The
 * fround matters: exporters store key f at the float32 time Math.fround(f / 60),
 * often a hair above the float64 f / 60, and three's STEP interpolant shows the
 * last key at or before action.time, so at f / 60 a stepped channel would show
 * key f - 1 (see frameTime in src/assets/sample.ts). Every helper position at
 * every sample of every clip must agree with the bake within 1 mu.
 *
 * three's DRACOLoader needs fetch + Blob workers, which Node lacks, so the glb
 * is loaded from a copy with Draco removed by gltf-transform. Only geometry is
 * Draco-compressed; the animation and node data the oracle reads is untouched.
 */
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import type { Document } from "@gltf-transform/core";
import { AnimationMixer, Vector3, type AnimationClip, type Object3D } from "three";
import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js";
import { bakeGlb } from "../src/assets/bake";
import { CONTRACT, HITBOXES_JSON, fromRepo, getIO, readGlb, type HitboxesFile } from "../src/assets/gltf";

const hb = JSON.parse(readFileSync(fromRepo(HITBOXES_JSON), "utf8")) as HitboxesFile;
const glbBytes = new Uint8Array(readFileSync(fromRepo(hb.source.file)));
let gltf: GLTF;

/** The glb as a Draco-free Document that three can load in Node. */
async function withoutDraco(): Promise<Document> {
  const doc = await readGlb(glbBytes);
  for (const ext of doc.getRoot().listExtensionsUsed()) if (ext.extensionName === "KHR_draco_mesh_compression") ext.dispose();
  return doc;
}

const loadInThree = (bytes: Uint8Array): Promise<GLTF> =>
  new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, "");

beforeAll(async () => {
  gltf = await loadInThree(await (await getIO()).writeBinary(await withoutDraco()));
});

const mu = (v: number) => Math.round(v * 1000);

/** The runtime's sampling instant for sim frame f (what ChickenView must set). */
const runtimeTime = (f: number) => Math.fround(f / 60);

function pose(obj: Object3D, mixer: AnimationMixer, clip: AnimationClip, time: number): void {
  mixer.stopAllAction();
  const action = mixer.clipAction(clip);
  action.play();
  action.time = time;
  mixer.update(0);
  obj.updateMatrixWorld(true);
}

/** Pose every sample of every clip in three at `time(f)` and list where it differs from `baked` by more than 1 mu. */
function compare(g: GLTF, baked: HitboxesFile, time: (f: number) => number): { compared: number; mismatches: string[] } {
  const scene = g.scene;
  const mixer = new AnimationMixer(scene);
  const hurt = scene.getObjectByName("hurt_body")!;
  const beak = scene.getObjectByName("hit_beak")!;
  const hh = hurt.userData["cf_half_height"] as number;
  const s = new Vector3();
  const mismatches: string[] = [];
  let compared = 0;
  for (const c of CONTRACT.clips) {
    const clip = g.animations.find((a) => a.name === c.name)!;
    const boxes = baked.clips[c.name]!;
    for (let f = 0; f <= c.frames; f++) {
      pose(scene, mixer, clip, time(f));
      const a = hurt.localToWorld(new Vector3(0, -hh, 0));
      const b = hurt.localToWorld(new Vector3(0, hh, 0));
      hurt.getWorldScale(s);
      const hurtR = (hurt.userData["cf_radius"] as number) * Math.max(s.x, s.z);
      const p = beak.getWorldPosition(new Vector3());
      beak.getWorldScale(s);
      const beakR = (beak.userData["cf_radius"] as number) * Math.max(s.x, s.y, s.z);
      const oracle = [mu(a.z), mu(a.y), mu(b.z), mu(b.y), mu(hurtR), mu(p.z), mu(p.y), mu(beakR)];
      const bake = [...boxes.hurt.slice(f * 5, f * 5 + 5), ...boxes.hit["hit_beak"]!.slice(f * 3, f * 3 + 3)];
      for (let i = 0; i < oracle.length; i++) {
        if (Math.abs(oracle[i]! - bake[i]!) > 1) mismatches.push(`${c.name} sample ${f} field ${i}: three.js ${oracle[i]} vs bake ${bake[i]}`);
      }
      compared++;
    }
  }
  mixer.uncacheRoot(scene);
  return { compared, mismatches };
}

describe("bake parity with three.js AnimationMixer", () => {
  it("loads the same 21 clips and helper extras", () => {
    expect(gltf.animations.map((a) => a.name).sort()).toEqual(CONTRACT.clips.map((c) => c.name).sort());
    expect(gltf.scene.getObjectByName("hurt_body")?.userData).toMatchObject({ cf_shape: "capsule", cf_radius: 0.4, cf_half_height: 0.42 });
    expect(gltf.scene.getObjectByName("hit_beak")?.userData).toMatchObject({ cf_shape: "sphere", cf_radius: 0.14 });
  });

  it("agrees with hitboxes.json within 1 mu at every sample of every clip", () => {
    const r = compare(gltf, hb, runtimeTime);
    expect(r.mismatches).toEqual([]);
    expect(r.compared).toBe(CONTRACT.clips.reduce((n, c) => n + c.frames + 1, 0));
  });

  it("still agrees when the clips are stepped (Blender exports a stepped bone curve as STEP with a key per frame)", async () => {
    const doc = await withoutDraco();
    let stepped = 0;
    for (const a of doc.getRoot().listAnimations()) {
      for (const s of a.listSamplers()) {
        if (s.getInterpolation() === "LINEAR" && s.getInput()!.getCount() > 2) {
          s.setInterpolation("STEP");
          stepped++;
        }
      }
    }
    expect(stepped).toBeGreaterThan(100);
    const bytes = await (await getIO()).writeBinary(doc);
    const baked = await bakeGlb(bytes, "stepped.glb");
    const g = await loadInThree(bytes);
    expect(compare(g, baked, runtimeTime).mismatches).toEqual([]);
    // The trap: posed at the float64 f / 60, three shows the previous key on many samples.
    expect(compare(g, baked, (f) => f / 60).mismatches.length).toBeGreaterThan(0);
  });
});
