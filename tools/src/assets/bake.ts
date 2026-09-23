/**
 * Bake the chicken's hitbox helpers into packages/sim/data/hitboxes.json, the
 * integer tables packages/sim/src/rules.ts compileRules() reads. The sim never
 * opens a glb; floats exist only here, at bake time.
 *
 * Every contract clip is posed at every sample 0..frames (sample f = sim frame
 * f, 60 Hz) and each helper is projected onto the sim plane: sim x = glTF +Z
 * (forward), sim y = glTF +Y, in model space with root at the origin, as
 * Math.round(v * 1000) + 0 (the + 0 turns -0 into 0).
 *
 * Sizes come from the helpers' extras (cf_radius, cf_half_height), not the
 * contract: the glb is what the renderer shows, so it is what gets baked.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Node } from "@gltf-transform/core";
import {
  CONTRACT,
  HITBOXES_JSON,
  fromRepo,
  readGlb,
  sha256,
  toRepo,
  type ClipBoxes,
  type Contract,
  type HitboxesFile,
} from "./gltf";
import { axisScale, buildRig, clipDuration, poseWorld, tracksOf, transformPoint } from "./sample";

export class BakeError extends Error {
  override name = "BakeError";
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function helperIndex(nodes: Node[], name: string): number {
  const found = nodes.flatMap((n, i) => (n.getName() === name ? [i] : []));
  if (found.length !== 1) throw new BakeError(`expected one node named "${name}", found ${found.length}`);
  return found[0] as number;
}

/**
 * The hit spheres to bake: the contract's sphere helpers plus any extra
 * `hit_*` node tagged cf_shape "sphere" (moves pick one with `hitNode`).
 */
function hitHelperNames(nodes: Node[], contract: Contract): string[] {
  const names = new Set(Object.keys(contract.helpers).filter((k) => contract.helpers[k]?.shape === "sphere"));
  for (const n of nodes) if (n.getName().startsWith("hit_") && n.getExtras()["cf_shape"] === "sphere") names.add(n.getName());
  return [...names].sort();
}

/** Bake a glb (bytes) whose repo path is `file` into a hitboxes object. */
export async function bakeGlb(bytes: Uint8Array, file: string, contract: Contract = CONTRACT): Promise<HitboxesFile> {
  const doc = await readGlb(bytes);
  const rig = buildRig(doc);
  const q = (v: number) => Math.round(v * contract.units) + 0;

  const capsules = Object.keys(contract.helpers).filter((k) => contract.helpers[k]?.shape === "capsule");
  if (capsules.length !== 1) throw new BakeError(`the contract must define exactly one capsule helper, found ${capsules.length}`);
  const hurtName = capsules[0] as string;
  const hurt = helperIndex(rig.nodes, hurtName);
  const hurtExtras = (rig.nodes[hurt] as Node).getExtras();
  const hurtR = num(hurtExtras["cf_radius"]);
  const hurtH = num(hurtExtras["cf_half_height"]);
  if (hurtR === undefined || hurtH === undefined) throw new BakeError(`${hurtName} is missing numeric cf_radius / cf_half_height extras`);

  const hits = hitHelperNames(rig.nodes, contract).map((name) => {
    const i = helperIndex(rig.nodes, name);
    const r = num((rig.nodes[i] as Node).getExtras()["cf_radius"]);
    if (r === undefined) throw new BakeError(`${name} is missing a numeric cf_radius extra`);
    return { name, i, r };
  });

  const animations = doc.getRoot().listAnimations();
  const clips: Record<string, ClipBoxes> = {};
  for (const clip of contract.clips) {
    const found = animations.filter((a) => a.getName() === clip.name);
    if (found.length !== 1) throw new BakeError(`expected one clip "${clip.name}", found ${found.length} (run pnpm assets:validate)`);
    const anim = found[0]!;
    const exact = clipDuration(anim) * contract.fps;
    const frames = Math.round(exact);
    if (Math.abs(exact - frames) > 1e-3 || frames !== clip.frames) {
      throw new BakeError(`clip "${clip.name}" lasts ${exact.toFixed(3)} frames, the contract says ${clip.frames}`);
    }
    const tracks = tracksOf(rig, anim);
    const hurtOut: number[] = [];
    const hitOut: number[][] = hits.map(() => []);
    for (let f = 0; f <= frames; f++) {
      const world = poseWorld(rig, tracks, f / contract.fps);
      const m = world[hurt]!;
      const a = transformPoint(m, [0, -hurtH, 0]);
      const b = transformPoint(m, [0, hurtH, 0]);
      hurtOut.push(q(a[2]), q(a[1]), q(b[2]), q(b[1]), q(hurtR * Math.max(axisScale(m, 0), axisScale(m, 2))));
      hits.forEach((h, k) => {
        const mh = world[h.i]!;
        const p = transformPoint(mh, [0, 0, 0]);
        hitOut[k]!.push(q(p[2]), q(p[1]), q(h.r * Math.max(axisScale(mh, 0), axisScale(mh, 1), axisScale(mh, 2))));
      });
    }
    clips[clip.name] = { n: frames, hurt: hurtOut, hit: Object.fromEntries(hits.map((h, k) => [h.name, hitOut[k]!])) };
  }

  return {
    v: 1,
    hz: contract.fps,
    units: contract.units,
    forward: "+Z",
    source: { file, sha256: sha256(bytes) },
    clips,
  };
}

/** Stable, diff-friendly JSON: fixed key order, one clip per line, contract clip order. */
export function formatHitboxes(h: HitboxesFile): string {
  const clipLines = Object.entries(h.clips).map(([name, c]) => {
    const hit = Object.fromEntries(Object.keys(c.hit).sort().map((k) => [k, c.hit[k]]));
    return `    ${JSON.stringify(name)}: ${JSON.stringify({ n: c.n, hurt: c.hurt, hit })}`;
  });
  return [
    "{",
    `  "v": ${JSON.stringify(h.v)},`,
    `  "hz": ${JSON.stringify(h.hz)},`,
    `  "units": ${JSON.stringify(h.units)},`,
    `  "forward": ${JSON.stringify(h.forward)},`,
    `  "source": ${JSON.stringify({ file: h.source.file, sha256: h.source.sha256 })},`,
    '  "clips": {',
    clipLines.join(",\n"),
    "  }",
    "}",
    "",
  ].join("\n");
}

/** Bake the glb at an absolute path; the source path is stored repo-relative. */
export async function bakeFile(glbPath: string, contract: Contract = CONTRACT): Promise<{ hitboxes: HitboxesFile; text: string }> {
  const hitboxes = await bakeGlb(new Uint8Array(readFileSync(glbPath)), toRepo(glbPath), contract);
  return { hitboxes, text: formatHitboxes(hitboxes) };
}

/** Write via a temp file + rename so a crash never leaves half a JSON file for the sim to import. */
export function writeHitboxes(text: string, path = fromRepo(HITBOXES_JSON)): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/** Describe how two bakes differ, for `bake --check`. */
export function diffHitboxes(committed: HitboxesFile, fresh: HitboxesFile): string[] {
  const out: string[] = [];
  if (committed.source?.sha256 !== fresh.source.sha256) {
    out.push(`source sha256 ${committed.source?.sha256 || "(empty)"} != glb ${fresh.source.sha256}`);
  }
  for (const [name, c] of Object.entries(fresh.clips)) {
    const old = committed.clips?.[name];
    if (!old) {
      out.push(`clip ${name}: missing from hitboxes.json`);
      continue;
    }
    const arrays: [string, number[] | undefined, number[], number][] = [
      ["hurt", old.hurt, c.hurt, 5],
      ...Object.keys(c.hit).map((k): [string, number[] | undefined, number[], number] => [k, old.hit?.[k], c.hit[k]!, 3]),
    ];
    for (const [label, a, b, stride] of arrays) {
      if (!a || a.length !== b.length) {
        out.push(`clip ${name} ${label}: length ${a?.length ?? 0} != ${b.length}`);
        continue;
      }
      const i = b.findIndex((v, j) => v !== a[j]);
      if (i >= 0) out.push(`clip ${name} ${label}: first difference at sample ${Math.floor(i / stride)} (${a[i]} -> ${b[i]})`);
    }
  }
  for (const name of Object.keys(committed.clips ?? {})) if (!(name in fresh.clips)) out.push(`clip ${name}: not in the contract`);
  return out;
}

/**
 * Re-bake the glb hitboxes.json points at and compare byte-for-byte with the
 * committed file. `ok` is false on any difference, including formatting.
 */
export async function checkHitboxes(path = fromRepo(HITBOXES_JSON), contract: Contract = CONTRACT): Promise<{ ok: boolean; problems: string[] }> {
  const text = readFileSync(path, "utf8");
  let committed: HitboxesFile;
  try {
    committed = JSON.parse(text) as HitboxesFile;
  } catch (e) {
    return { ok: false, problems: [`hitboxes.json is not valid JSON: ${(e as Error).message}`] };
  }
  if (!committed.source?.file) return { ok: false, problems: ["hitboxes.json has no source.file (it was never baked)"] };
  let fresh: { hitboxes: HitboxesFile; text: string };
  try {
    fresh = await bakeFile(fromRepo(committed.source.file), contract);
  } catch (e) {
    return { ok: false, problems: [`cannot bake ${committed.source.file}: ${(e as Error).message}`] };
  }
  if (fresh.text === text) return { ok: true, problems: [] };
  const problems = diffHitboxes(committed, fresh.hitboxes);
  return { ok: false, problems: problems.length ? problems : ["formatting differs from a fresh bake"] };
}
