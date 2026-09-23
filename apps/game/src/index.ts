/**
 * Process entry point: `pnpm dev` runs it through tsx, production runs the
 * esbuild bundle (dist/server.mjs). Boots with zero env vars.
 */
import { loadGameEnv } from "@cockfight/shared/env";
import { listen, makeServer } from "./server";

const env = loadGameEnv(process.env);

if (env.NODE_ENV === "production" && env.ALLOWED_ORIGINS.some((o) => /^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(o))) {
  console.warn("[game] ALLOWED_ORIGINS still lists a localhost origin in production; set it to the web app's origin.");
}

const server = makeServer({ env });
try {
  // 0.0.0.0, not localhost: Fly's proxy reaches the machine over its external interface.
  await listen(server, env.PORT, "0.0.0.0");
} catch (err) {
  console.error(`[game] cannot listen on 0.0.0.0:${env.PORT}:`, err instanceof Error ? err.message : err);
  process.exit(1);
}
console.log(`[game] listening on 0.0.0.0:${env.PORT} region=${env.FLY_REGION} origins=${env.ALLOWED_ORIGINS.join(",")}`);
