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

if (env.GATE_MODE === "required" && (!env.NEXT_PUBLIC_COCK_MINT || !(env.HELIUS_API_KEY || env.SOLANA_RPC_URL))) {
  console.warn("[game] GATE_MODE=required but NEXT_PUBLIC_COCK_MINT or HELIUS_API_KEY is unset: POST /gate answers 503 until both are set.");
}
if (env.GATE_MODE === "required" && !env.QUEUE_JWT_SECRET) {
  console.warn("[game] QUEUE_JWT_SECRET is unset: queue tokens use a per-process secret (fine for one machine; set it before running two).");
}
if (env.GATE_MODE === "required" && !(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY)) {
  console.warn("[game] Supabase is not configured: ranked results are kept in memory only.");
}

const server = makeServer({ env });
try {
  // 0.0.0.0, not localhost: Fly's proxy reaches the machine over its external interface.
  await listen(server, env.PORT, "0.0.0.0");
} catch (err) {
  console.error(`[game] cannot listen on 0.0.0.0:${env.PORT}:`, err instanceof Error ? err.message : err);
  process.exit(1);
}
console.log(`[game] listening on 0.0.0.0:${env.PORT} region=${env.FLY_REGION} gate=${env.GATE_MODE} origins=${env.ALLOWED_ORIGINS.join(",")}`);
