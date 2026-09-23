/**
 * `pnpm textures` (tools/textures.sh) without KTX-Software: --dry-run prints
 * the `ktx create` commands, and this checks them against
 *   - the option set and the cross-option rules of KTX-Software v4.4.0's
 *     `ktx create` (tools/ktx/command_create.cpp, encode_utils_basis.h,
 *     encode_utils_common.h), which would reject a bad combination at run time;
 *   - what the game needs: each map's transfer function is the one
 *     assets:validate expects (TIER_MAPS), data maps are never colour
 *     converted, normals stay RGB = XYZ for three.js, UASTC is supercompressed.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { TIER_MAPS } from "../src/assets/textures";
import { repoPath } from "../src/root";
import { fakePng } from "./helpers/images";

const tmp = mkdtempSync(join(tmpdir(), "cf-textures-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const script = repoPath("tools", "textures.sh");
const run = (args: string[], env: NodeJS.ProcessEnv = process.env) => spawnSync("sh", [script, ...args], { cwd: repoPath(), encoding: "utf8", env });

/** `ktx create` 4.4 options this pipeline may use: name -> takes a value. Anything else is a typo or a flag from another version. */
const KTX_CREATE_OPTIONS: Record<string, boolean> = {
  format: true,
  "generate-mipmap": false,
  encode: true,
  "assign-tf": true,
  "assign-primaries": true,
  "convert-tf": true,
  "convert-primaries": true,
  "fail-on-color-conversions": false,
  "warn-on-color-conversions": false,
  "no-warn-on-color-conversions": false,
  "mipmap-filter": true,
  "mipmap-wrap": true,
  normalize: false,
  // basis-lz
  clevel: true,
  qlevel: true,
  // uastc
  "uastc-quality": true,
  "uastc-rdo": false,
  "uastc-rdo-l": true,
  "uastc-rdo-d": true,
  "uastc-rdo-m": false,
  // common encoder options and supercompression
  "normal-mode": false,
  threads: true,
  zstd: true,
  zlib: true,
};

/** The formats `ktx create` accepts together with --encode. */
const ENCODE_FORMATS = ["R8_UNORM", "R8_SRGB", "R8G8_UNORM", "R8G8_SRGB", "R8G8B8_UNORM", "R8G8B8_SRGB", "R8G8B8A8_UNORM", "R8G8B8A8_SRGB"];

interface Command {
  opts: Map<string, string | true>;
  input: string;
  output: string;
}

function parse(line: string): Command {
  const words = line.split(" ");
  expect(words.slice(0, 2)).toEqual(["ktx", "create"]);
  const opts = new Map<string, string | true>();
  const rest = words.slice(2);
  while (rest.length > 2) {
    const word = rest.shift()!;
    expect(word, line).toMatch(/^--/);
    const name = word.slice(2);
    expect(KTX_CREATE_OPTIONS, `--${name} is not a ktx create 4.4 option`).toHaveProperty([name]);
    expect(opts.has(name), `--${name} given twice`).toBe(false);
    opts.set(name, KTX_CREATE_OPTIONS[name] ? rest.shift()! : true);
  }
  expect(rest, line).toHaveLength(2);
  return { opts, input: rest[0]!, output: rest[1]! };
}

/** The checks `ktx create` 4.4 itself makes before encoding (each would abort the run). */
function ktxWouldReject(c: Command): string[] {
  const o = c.opts;
  const bad: string[] = [];
  const num = (name: string) => Number(o.get(name));
  const has = (name: string) => o.has(name);
  const format = String(o.get("format"));
  const encode = o.get("encode");
  if (!has("format")) bad.push("--format is required");
  if (has("encode") && !ENCODE_FORMATS.includes(format)) bad.push(`--format ${format} cannot be encoded`);
  if (encode !== undefined && encode !== "basis-lz" && encode !== "uastc") bad.push(`--encode ${String(encode)}`);
  // "Transfer function must be sRGB for sRGB formats" / "must not be sRGB for a non-sRGB VkFormat with sRGB variant".
  const tf = o.get("assign-tf");
  if (format.endsWith("_SRGB") && tf !== undefined && tf !== "srgb") bad.push(`--assign-tf ${String(tf)} with an sRGB format`);
  if (format.endsWith("_UNORM") && tf === "srgb") bad.push("--assign-tf srgb with a UNORM format");
  if (has("convert-primaries") && o.get("assign-primaries") === "none") bad.push("--convert-primaries with --assign-primaries none");
  // "Cannot encode to BasisLZ and supercompress with Zstd/ZLIB."
  if (encode === "basis-lz" && (has("zstd") || has("zlib"))) bad.push("BasisLZ with --zstd/--zlib");
  // Codec-specific options are rejected for the other codec; RDO options need --uastc-rdo.
  for (const name of ["clevel", "qlevel"]) if (has(name) && encode !== "basis-lz") bad.push(`--${name} without basis-lz`);
  for (const name of ["uastc-quality", "uastc-rdo", "uastc-rdo-l", "uastc-rdo-d", "uastc-rdo-m"]) if (has(name) && encode !== "uastc") bad.push(`--${name} without uastc`);
  for (const name of ["uastc-rdo-l", "uastc-rdo-d", "uastc-rdo-m"]) if (has(name) && !has("uastc-rdo")) bad.push(`--${name} without --uastc-rdo`);
  if (has("fail-on-color-conversions") && has("warn-on-color-conversions")) bad.push("--fail- and --warn-on-color-conversions");
  // Documented ranges.
  const ranges: [string, number, number][] = [
    ["clevel", 0, 6],
    ["qlevel", 1, 255],
    ["uastc-quality", 0, 4],
    ["uastc-rdo-l", 0.001, 10],
    ["zstd", 1, 22],
  ];
  for (const [name, lo, hi] of ranges) if (has(name) && !(num(name) >= lo && num(name) <= hi)) bad.push(`--${name} ${num(name)} outside ${lo}..${hi}`);
  return bad;
}

function artDir(files: string[]): string {
  const dir = join(tmp, `art${Math.random().toString(36).slice(2)}`);
  for (const f of files) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), fakePng(2048));
  }
  return dir;
}

describe.skipIf(process.platform === "win32")("pnpm textures (tools/textures.sh)", () => {
  const maps = Object.keys(TIER_MAPS);
  const src = artDir([...maps.map((m) => `rust/${m}.png`), "gold/basecolor.png", "gold/notes.txt"]);
  const out = join(tmp, "public-textures");
  const dry = run(["--dry-run", "--src", src, "--out", out], { ...process.env, PATH: "/usr/bin:/bin" });
  const commands = dry.stdout.trim().split("\n").map(parse);
  const byOutput = new Map(commands.map((c) => [c.output, c]));

  it("--dry-run prints one ktx create per map found, without needing KTX-Software", () => {
    expect(dry.status, dry.stderr).toBe(0);
    expect(commands.map((c) => c.output).sort()).toEqual([...maps.map((m) => join(out, "rust", `${m}.ktx2`)), join(out, "gold", "basecolor.ktx2")].sort());
    for (const c of commands) expect(c.input).toBe(join(src, c.output.slice(out.length + 1).replace(/\.ktx2$/, ".png")));
  });

  it("every command passes the checks ktx create 4.4 makes before encoding", () => {
    for (const c of commands) expect(ktxWouldReject(c), c.output).toEqual([]);
  });

  it("assigns each map the transfer function assets:validate expects, so nothing is colour converted", () => {
    for (const [map, transfer] of Object.entries(TIER_MAPS)) {
      const o = byOutput.get(join(out, "rust", `${map}.ktx2`))!.opts;
      expect(o.get("assign-tf"), map).toBe(transfer);
      expect(String(o.get("format")), map).toBe(transfer === "srgb" ? "R8G8B8_SRGB" : "R8G8B8_UNORM");
      // Data carries no colour primaries; colour maps are sRGB's (BT.709). Assigned, never converted.
      expect(o.get("assign-primaries"), map).toBe(transfer === "srgb" ? "bt709" : "none");
      for (const convert of ["convert-tf", "convert-primaries"]) expect(o.has(convert), `${map} --${convert}`).toBe(false);
      expect(o.get("fail-on-color-conversions"), map).toBe(true);
      expect(o.get("generate-mipmap"), map).toBe(true);
    }
  });

  it("encodes colour maps ETC1S and data maps UASTC with RDO + Zstandard; normals stay RGB = XYZ", () => {
    for (const map of ["basecolor", "emissive"]) expect(byOutput.get(join(out, "rust", `${map}.ktx2`))!.opts.get("encode"), map).toBe("basis-lz");
    for (const map of ["orm", "normal"]) {
      const o = byOutput.get(join(out, "rust", `${map}.ktx2`))!.opts;
      expect(o.get("encode"), map).toBe("uastc");
      expect(o.get("uastc-rdo"), map).toBe(true);
      expect(Number(o.get("zstd")), map).toBeGreaterThanOrEqual(18);
    }
    const normal = byOutput.get(join(out, "rust", "normal.ktx2"))!.opts;
    // --normal-mode would store X+Y as RGB = X, A = Y; three.js normalMap samples .xyz.
    expect(normal.has("normal-mode")).toBe(false);
    expect(Number(normal.get("uastc-rdo-l"))).toBeLessThanOrEqual(0.75); // the ktx docs' range for normal maps
  });

  it("skips cleanly without art/textures, rejects unknown options, and explains a missing ktx", () => {
    const none = run(["--dry-run", "--src", join(tmp, "no-such-dir")]);
    expect(none.status).toBe(0);
    expect(none.stdout).toContain("nothing to convert");
    const typo = run(["--dryrun"]);
    expect(typo.status).toBe(2);
    expect(typo.stderr).toContain("unknown option --dryrun");
    const noKtx = run(["--src", src, "--out", out], { ...process.env, PATH: "/usr/bin:/bin" });
    expect(noKtx.status).toBe(2);
    expect(noKtx.stderr).toContain("'ktx' (KTX-Software 4.4+) is not installed");
  });
});
