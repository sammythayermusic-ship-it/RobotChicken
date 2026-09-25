/**
 * Static test build: `pnpm --filter @cockfight/web export` writes a plain
 * static site to apps/web/out/ that any static host can serve (Netlify Drop,
 * `netlify deploy --dir`). Local play (vs CPU, 2P on one keyboard) runs
 * entirely in the browser, so no game server is needed.
 *
 * Writes out/_headers (Netlify's format) with the same security headers the
 * Next server sends (src/lib/csp.ts), cache rules for the decoders and models,
 * and X-Robots-Tag: noindex so a test link stays out of search results.
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const run = (cmd, args, env = {}) => {
  const r = spawnSync(cmd, args, { cwd: web, stdio: "inherit", env: { ...process.env, ...env } });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

run("node", ["scripts/copy-decoders.mjs"]);
run("node", ["node_modules/next/dist/bin/next", "build"], { STATIC_EXPORT: "1" });

// csp.ts has no imports and only erasable TypeScript, so Node 22 loads it directly.
const { securityHeaders } = await import(join(web, "src/lib/csp.ts"));
const gameWsUrl = process.env.NEXT_PUBLIC_GAME_WS_URL || "ws://localhost:2567";
const lines = ["/*", ...securityHeaders({ dev: false, gameWsUrl }).map((h) => `  ${h.key}: ${h.value}`), "  X-Robots-Tag: noindex"];
lines.push("", "/decoders/*", "  Cache-Control: public, max-age=31536000, immutable");
lines.push("", "/models/*", "  Cache-Control: public, max-age=0, must-revalidate");
writeFileSync(join(web, "out/_headers"), lines.join("\n") + "\n");
console.log("\nexport: static site in apps/web/out (with _headers). Serve it from any static host.");
