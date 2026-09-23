/**
 * An independent oracle for the bake: three.js (the runtime that draws the
 * chicken) loads the glb with GLTFLoader and poses it with AnimationMixer the
 * way the game will (action.time = f/60; mixer.update(0)). Every helper
 * position at every sample of every clip must agree with hitboxes.json within
 * 1 mu.
 *
 * three's DRACOLoader needs fetch + Blob workers, which Node lacks, so the glb
 * is loaded from a copy with Draco removed by gltf-transform. Only geometry is
 * Draco-compressed; the animation and node data the oracle reads is untouched.
 */
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { AnimationMixer, Vector3, type AnimationClip, type Object3D } from "three";
import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js";
import { CONTRACT, HITBOXES_JSON, fromRepo, getIO, readGlb, type HitboxesFile } from "../src/assets/gltf";

const hb = JSON.parse(readFileSync(fromRepo(HITBOXES_JSON), "utf8")) as HitboxesFile;
let gltf: GLTF;

beforeAll(async () => {
  const doc = await readGlb(new Uint8Array(readFileSync(fromRepo(hb.source.file))));
  for (const ext of doc.getRoot().listExtensionsUsed()) if (ext.extensionName === "KHR_draco_mesh_compression") ext.dispose();
  const bytes = await (await getIO()).writeBinary(doc);
  gltf = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "");
});

const mu = (v: number) => Math.round(v * 1000);

function pose(obj: Object3D, mixer: AnimationMixer, clip: AnimationClip, frame: number): void {
  mixer.stopAllAction();
  const action = mixer.clipAction(clip);
  action.play();
  action.time = frame / 60;
  mixer.update(0);
  obj.updateMatrixWorld(true);
}

describe("bake parity with three.js AnimationMixer", () => {
  it("loads the same 21 clips and helper extras", () => {
    expect(gltf.animations.map((a) => a.name).sort()).toEqual(CONTRACT.clips.map((c) => c.name).sort());
    expect(gltf.scene.getObjectByName("hurt_body")?.userData).toMatchObject({ cf_shape: "capsule", cf_radius: 0.4, cf_half_height: 0.42 });
    expect(gltf.scene.getObjectByName("hit_beak")?.userData).toMatchObject({ cf_shape: "sphere", cf_radius: 0.14 });
  });

  it("agrees with hitboxes.json within 1 mu at every sample of every clip", () => {
    const scene = gltf.scene;
    const mixer = new AnimationMixer(scene);
    const hurt = scene.getObjectByName("hurt_body")!;
    const beak = scene.getObjectByName("hit_beak")!;
    const hh = hurt.userData["cf_half_height"] as number;
    const s = new Vector3();
    let compared = 0;
    let worst = 0;
    for (const c of CONTRACT.clips) {
      const clip = gltf.animations.find((a) => a.name === c.name)!;
      const baked = hb.clips[c.name]!;
      for (let f = 0; f <= c.frames; f++) {
        pose(scene, mixer, clip, f);
        const a = hurt.localToWorld(new Vector3(0, -hh, 0));
        const b = hurt.localToWorld(new Vector3(0, hh, 0));
        hurt.getWorldScale(s);
        const hurtR = (hurt.userData["cf_radius"] as number) * Math.max(s.x, s.z);
        const p = beak.getWorldPosition(new Vector3());
        beak.getWorldScale(s);
        const beakR = (beak.userData["cf_radius"] as number) * Math.max(s.x, s.y, s.z);
        const oracle = [mu(a.z), mu(a.y), mu(b.z), mu(b.y), mu(hurtR), mu(p.z), mu(p.y), mu(beakR)];
        const bake = [...baked.hurt.slice(f * 5, f * 5 + 5), ...baked.hit["hit_beak"]!.slice(f * 3, f * 3 + 3)];
        for (let i = 0; i < oracle.length; i++) {
          const d = Math.abs(oracle[i]! - bake[i]!);
          worst = Math.max(worst, d);
          if (d > 1) expect.fail(`${c.name} sample ${f} field ${i}: three.js ${oracle[i]} vs bake ${bake[i]}`);
        }
        compared++;
      }
    }
    expect(compared).toBe(CONTRACT.clips.reduce((n, c) => n + c.frames + 1, 0));
    expect(worst).toBeLessThanOrEqual(1);
  });
});
