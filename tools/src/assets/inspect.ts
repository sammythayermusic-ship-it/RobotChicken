/**
 * assets:inspect: a plain-text summary of a glb (node tree, skin, materials,
 * clips) for eyeballing an export without opening Blender.
 */
import type { Document, Node } from "@gltf-transform/core";
import { getGLPrimitiveCount } from "@gltf-transform/functions";
import { readGlb, sha256 } from "./gltf";
import { clipDuration } from "./sample";

const fmt = (v: ArrayLike<number>) => `[${Array.from(v, (x) => +x.toFixed(4)).join(", ")}]`;

function isIdentity(n: Node): boolean {
  const t = n.getTranslation();
  const r = n.getRotation();
  const s = n.getScale();
  return t.every((v) => Math.abs(v) < 1e-6) && Math.abs(r[3] - 1) < 1e-6 && s.every((v) => Math.abs(v - 1) < 1e-6);
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
      isIdentity(n) ? "" : `t=${fmt(n.getTranslation())} r=${fmt(n.getRotation())} s=${fmt(n.getScale())}`,
      Object.keys(n.getExtras()).length ? `extras=${JSON.stringify(n.getExtras())}` : "",
    ].filter(Boolean);
    lines.push(`${"  ".repeat(depth + 1)}${n.getName() || "(unnamed)"}${tags.length ? `  ${tags.join("  ")}` : ""}`);
    for (const c of n.listChildren()) walk(c, depth + 1);
  };
  for (const scene of root.listScenes()) for (const n of scene.listChildren()) walk(n, 0);

  lines.push("materials:");
  for (const m of root.listMaterials()) {
    lines.push(
      `  ${m.getName()}  base=${fmt(m.getBaseColorFactor())} metal=${m.getMetallicFactor()} rough=${m.getRoughnessFactor()}` +
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
  const asset = doc.getRoot().getAsset();
  return [`${file}  ${bytes.length} bytes  sha256 ${sha256(bytes)}`, `generator: ${asset.generator ?? "?"}`, ...describeDocument(doc)].join("\n");
}
