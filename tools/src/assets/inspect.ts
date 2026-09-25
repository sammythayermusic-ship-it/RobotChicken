/**
 * assets:inspect: a plain-text summary of a glb (node tree, skin, materials,
 * clips) for eyeballing an export without opening Blender.
 */
import type { Document, Node } from "@gltf-transform/core";
import { getGLPrimitiveCount } from "@gltf-transform/functions";
import { readGlb, sha256 } from "./gltf";
import { clipDuration } from "./sample";

const num = (x: number) => +x.toFixed(4);
const fmt = (v: ArrayLike<number>) => `[${Array.from(v, num).join(", ")}]`;
const off = (v: ArrayLike<number>, rest: number[]) => Array.from(v).some((x, i) => Math.abs(x - (rest[i] as number)) > 1e-6);

/** Only the non-rest parts of a node's TRS. */
function trs(n: Node): string {
  return [
    off(n.getTranslation(), [0, 0, 0]) ? `t=${fmt(n.getTranslation())}` : "",
    off(n.getRotation(), [0, 0, 0, 1]) ? `r=${fmt(n.getRotation())}` : "",
    off(n.getScale(), [1, 1, 1]) ? `s=${fmt(n.getScale())}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** asset.generator as written in the file (gltf-transform replaces it on read). */
function fileGenerator(bytes: Uint8Array): string {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + view.getUint32(12, true)))) as { asset?: { generator?: string } };
    return json.asset?.generator ?? "?";
  } catch {
    return "?";
  }
}

export function describeDocument(doc: Document, fps = 60): string[] {
  const root = doc.getRoot();
  const lines: string[] = [];
  const joints = new Set(root.listSkins().flatMap((s) => s.listJoints()));

  lines.push(`extensions: ${root.listExtensionsUsed().map((e) => e.extensionName).join(", ") || "(none)"}`);
  lines.push("nodes:");
  const walk = (n: Node, depth: number) => {
    const tags = [
      joints.has(n) ? "joint" : "",
      n.getMesh() ? `mesh ${n.getMesh()!.getName()}` : "",
      n.getSkin() ? `skin(${n.getSkin()!.listJoints().length})` : "",
      trs(n),
      Object.keys(n.getExtras()).length ? `extras=${JSON.stringify(n.getExtras())}` : "",
    ].filter(Boolean);
    lines.push(`${"  ".repeat(depth + 1)}${n.getName() || "(unnamed)"}${tags.length ? `  ${tags.join("  ")}` : ""}`);
    for (const c of n.listChildren()) walk(c, depth + 1);
  };
  for (const scene of root.listScenes()) for (const n of scene.listChildren()) walk(n, 0);

  lines.push("materials:");
  for (const m of root.listMaterials()) {
    lines.push(
      `  ${m.getName()}  base=${fmt(m.getBaseColorFactor())} metal=${num(m.getMetallicFactor())} rough=${num(m.getRoughnessFactor())}` +
        `${m.getEmissiveFactor().some((v) => v > 0) ? ` emissive=${fmt(m.getEmissiveFactor())}` : ""}${m.getDoubleSided() ? " doubleSided" : ""}`,
    );
  }
  lines.push("meshes:");
  for (const mesh of root.listMeshes()) {
    for (const p of mesh.listPrimitives()) {
      lines.push(
        `  ${mesh.getName()}  material=${p.getMaterial()?.getName() ?? "(none)"} tris=${getGLPrimitiveCount(p)} ` +
          `attributes=${p.listSemantics().join(",")}`,
      );
    }
  }
  lines.push("animations:");
  for (const a of root.listAnimations()) {
    const interp = new Map<string, number>();
    let bytes = 0;
    for (const s of a.listSamplers()) {
      interp.set(s.getInterpolation(), (interp.get(s.getInterpolation()) ?? 0) + 1);
      bytes += (s.getInput()?.getByteLength() ?? 0) + (s.getOutput()?.getByteLength() ?? 0);
    }
    const frames = clipDuration(a) * fps;
    const extras = Object.keys(a.getExtras()).length ? `  extras=${JSON.stringify(a.getExtras())}` : "";
    lines.push(
      `  ${a.getName().padEnd(10)} ${frames.toFixed(2).padStart(6)} frames  ${a.listChannels().length} channels  ` +
        `${[...interp].map(([k, v]) => `${k}:${v}`).join(" ")}  ${(bytes / 1024).toFixed(1)} KB${extras}`,
    );
  }
  return lines;
}

export async function inspectGlb(bytes: Uint8Array, file: string): Promise<string> {
  const doc = await readGlb(bytes);
  return [`${file}  ${bytes.length} bytes  sha256 ${sha256(bytes)}`, `generator: ${fileGenerator(bytes)}`, ...describeDocument(doc)].join("\n");
}
