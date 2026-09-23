import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REVISION } from "three";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decoderPaths } from "./decoders";

const script = fileURLToPath(new URL("../../../scripts/copy-decoders.mjs", import.meta.url));
const threeJsm = path.join(path.dirname(createRequire(import.meta.url).resolve("three/src/constants.js")), "../examples/jsm");

const run = (out: string) => execFileSync(process.execPath, [script, "--out", out], { encoding: "utf8" });

describe("decoderPaths", () => {
  it("puts the three revision in the path", () => {
    expect(decoderPaths()).toEqual({ draco: `/decoders/r${REVISION}/draco/`, basis: `/decoders/r${REVISION}/basis/` });
    expect(decoderPaths("999").draco).toBe("/decoders/r999/draco/");
  });
});

describe("scripts/copy-decoders.mjs", () => {
  let out: string;
  beforeEach(() => {
    out = fs.mkdtempSync(path.join(os.tmpdir(), "cf-decoders-"));
  });
  afterEach(() => {
    fs.rmSync(out, { recursive: true, force: true });
  });

  it("copies byte-identical decoders to exactly the URLs the runtime requests", () => {
    run(out);
    const { draco, basis } = decoderPaths();
    const served = (url: string, file: string) => path.join(out, url.replace(/^\/decoders\//, ""), file);
    const expected: [string, string][] = [
      [served(draco, "draco_decoder.wasm"), "libs/draco/gltf/draco_decoder.wasm"],
      [served(draco, "draco_wasm_wrapper.js"), "libs/draco/gltf/draco_wasm_wrapper.js"],
      [served(draco, "draco_decoder.js"), "libs/draco/gltf/draco_decoder.js"],
      [served(basis, "basis_transcoder.js"), "libs/basis/basis_transcoder.js"],
      [served(basis, "basis_transcoder.wasm"), "libs/basis/basis_transcoder.wasm"],
    ];
    for (const [dst, src] of expected) {
      expect(fs.readFileSync(dst).equals(fs.readFileSync(path.join(threeJsm, src))), dst).toBe(true);
    }
  });

  it("is idempotent and prunes decoders left over from another three revision", () => {
    fs.mkdirSync(path.join(out, "r1", "draco"), { recursive: true });
    fs.mkdirSync(path.join(out, "keep-me"));
    expect(run(out)).toContain("5 updated");
    const wasm = path.join(out, `r${REVISION}`, "draco", "draco_decoder.wasm");
    const mtime = fs.statSync(wasm).mtimeMs;
    expect(run(out)).toContain("0 updated");
    expect(fs.statSync(wasm).mtimeMs).toBe(mtime);
    expect(fs.readdirSync(out).sort()).toEqual(["keep-me", `r${REVISION}`]);
  });
});
