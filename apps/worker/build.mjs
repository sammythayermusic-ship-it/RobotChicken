// Bundles the worker into one self-contained ESM file, dist/worker.mjs, with
// every dependency inlined, so the runtime image ships dist/ and nothing else.
// Paths resolve from this file, so `node apps/worker/build.mjs` works from any cwd.
import { build } from "esbuild";
import { rmSync, statSync } from "node:fs";
import { join } from "node:path";

const here = import.meta.dirname;
const outfile = join(here, "dist", "worker.mjs");

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
  sourcesContent: false,
  // Nothing bundled today is CommonJS, but Phase 3's chain libraries are; give
  // them a require() now rather than debugging "Dynamic require" in production.
  banner: {
    js: "import{createRequire as __cfCreateRequire}from'node:module';const require=__cfCreateRequire(import.meta.url);",
  },
  logLevel: "warning",
  metafile: true,
});

const kb = (statSync(outfile).size / 1024).toFixed(0);
console.log(`built ${outfile} (${kb} KiB, ${Object.keys(result.metafile.inputs).length} inputs)`);
