#!/usr/bin/env node
/**
 * Copies three's Draco and Basis decoders into public/decoders/r<REV>/.
 *
 * Self-hosted, not the gstatic CDN: same origin (no extra CSP entry, DNS or
 * TLS round trip) and always the exact version the loaders were built for.
 * The three.js revision is part of the path, so the files can be served
 * `immutable`: a three upgrade changes the URL instead of leaving browsers on
 * a stale wasm for a year. The runtime builds the same path from three's
 * exported REVISION (src/game/engine/decoders.ts).
 *
 * Runs inline in the `dev` and `build` scripts (not a pre-script, which a
 * direct `next build` would skip). Idempotent: unchanged files are not
 * rewritten, and other r<N> directories left over from an old three are removed.
 *
 *   node scripts/copy-decoders.mjs [--out <dir>]   (default: public/decoders)
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

/** `three/package.json` is not in three's exports map; `three/src/*` is. */
const constantsFile = require.resolve("three/src/constants.js");
const threeDir = path.resolve(path.dirname(constantsFile), "..");

function threeRevision() {
  const m = /export const REVISION = '(\d+)'/.exec(fs.readFileSync(constantsFile, "utf8"));
  if (!m) throw new Error(`copy-decoders: no REVISION in ${constantsFile}`);
  const rev = m[1];
  // Cross-check with the package version (0.<rev>.<patch>): a mismatch means
  // the resolution above found the wrong three.
  const { version } = JSON.parse(fs.readFileSync(path.join(threeDir, "package.json"), "utf8"));
  if (version.split(".")[1] !== rev) throw new Error(`copy-decoders: three ${version} but REVISION ${rev}`);
  return rev;
}

const FILES = [
  ["libs/draco/gltf/draco_decoder.wasm", "draco/draco_decoder.wasm"],
  ["libs/draco/gltf/draco_wasm_wrapper.js", "draco/draco_wasm_wrapper.js"],
  ["libs/draco/gltf/draco_decoder.js", "draco/draco_decoder.js"],
  ["libs/basis/basis_transcoder.js", "basis/basis_transcoder.js"],
  ["libs/basis/basis_transcoder.wasm", "basis/basis_transcoder.wasm"],
];

function sameBytes(a, b) {
  if (!fs.existsSync(b)) return false;
  if (fs.statSync(a).size !== fs.statSync(b).size) return false;
  return fs.readFileSync(a).equals(fs.readFileSync(b));
}

function main() {
  const i = process.argv.indexOf("--out");
  const outRoot = i > 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : path.resolve(here, "../public/decoders");
  const rev = threeRevision();
  const dir = `r${rev}`;

  let updated = 0;
  for (const [from, to] of FILES) {
    const src = path.join(threeDir, "examples/jsm", from);
    const dst = path.join(outRoot, dir, to);
    if (sameBytes(src, dst)) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    updated++;
  }

  // Only r<digits> directories are ours to prune; anything else is left alone.
  for (const name of fs.readdirSync(outRoot)) {
    if (name !== dir && /^r\d+$/.test(name)) fs.rmSync(path.join(outRoot, name), { recursive: true, force: true });
  }

  console.log(`copy-decoders: three r${rev} -> ${path.relative(process.cwd(), path.join(outRoot, dir)) || "."} (${FILES.length} files, ${updated} updated)`);
}

main();
