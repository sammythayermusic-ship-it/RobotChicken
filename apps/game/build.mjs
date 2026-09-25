// Bundles the game server into one self-contained ESM file, dist/server.mjs.
// Every dependency (Colyseus, ws, express, zod, the workspace sim and its JSON
// data) is inlined, so the runtime image ships dist/ and nothing else: no
// node_modules, no pnpm, no workspace symlinks.
//
// Paths resolve from this file, so `node apps/game/build.mjs` works from any cwd
// (the Dockerfile runs it without pnpm).
import { build } from "esbuild";
import { rmSync, statSync } from "node:fs";
import { join } from "node:path";

const here = import.meta.dirname;
const outfile = join(here, "dist", "server.mjs");

// Left out of the bundle on purpose. Each is loaded inside a try/catch with a
// fallback, so the bundle runs without it (smoke.ts proves that from an empty dir).
const external = [
  // msgpackr's optional native string decoder. It IS installed (as msgpackr's
  // optional dependency), so without this esbuild inlines its node-gyp-build
  // loader, which then hunts for a .node binary the image never has. Its build
  // script is disabled anyway (allowBuilds: msgpackr-extract: false).
  "msgpackr-extract",
  // PM2 metrics. core's Stats does `import("@pm2/io").catch(() => {})`, and the
  // package is installed (via the @colyseus/tools dev dependency), so without
  // this esbuild inlines it and every boot would start PM2's metrics agent
  // (require hooks, intervals) on a server PM2 never manages.
  "@pm2/io",
  // ws's optional native addons. Not installed; esbuild already leaves an
  // unresolvable require() inside try/catch alone, and listing them keeps that
  // true if one ever arrives transitively (a native addon cannot be bundled).
  // (The Colyseus Redis driver/presence must stay bundleable: Phase 2 needs them.)
  "bufferutil",
  "utf-8-validate",
];

rmSync(join(here, "dist"), { recursive: true, force: true });

const result = await build({
  absWorkingDir: here,
  entryPoints: ["src/index.ts"],
  outfile,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: "linked",
  // Stack traces only need the mappings; the sources themselves stay out of the image.
  sourcesContent: false,
  external,
  // Bundled CommonJS (express, ws, debug, ...) calls require(); ESM has none, so
  // define one. The alias is unlikely to collide with a bundled top-level name.
  banner: {
    js: "import{createRequire as __cfCreateRequire}from'node:module';const require=__cfCreateRequire(import.meta.url);",
  },
  logLevel: "warning",
  metafile: true,
});

const kb = (statSync(outfile).size / 1024).toFixed(0);
console.log(`built ${outfile} (${kb} KiB, ${Object.keys(result.metafile.inputs).length} inputs)`);
