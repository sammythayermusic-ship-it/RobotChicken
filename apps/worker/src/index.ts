/**
 * Worker entry point (`pnpm dev` via tsx, production via dist/worker.mjs).
 *
 * Phase 0 ships only the process, image and Fly machine with a health check,
 * so deploys and monitoring exist before Phase 3 adds fee claims and payouts.
 * This build contains no payout code, whatever PAYOUTS_ENABLED says.
 */
import { loadWorkerEnv } from "@cockfight/shared/env";
import { createWorkerServer } from "./server";

const env = loadWorkerEnv(process.env);

console.log("[worker] payouts are disabled: this build only serves /health (payouts arrive in Phase 3)");
if (env.PAYOUTS_ENABLED) {
  console.warn("[worker] PAYOUTS_ENABLED=true is ignored: this build has no payout code");
}

const server = createWorkerServer();
server.on("error", (err) => {
  console.error("[worker] server error:", err);
  process.exit(1);
});
server.listen(env.PORT, "0.0.0.0", () => {
  console.log(`[worker] listening on 0.0.0.0:${env.PORT} region=${env.FLY_REGION}`);
});

let stopping = false;
function shutdown(signal: NodeJS.Signals): void {
  if (stopping) return;
  stopping = true;
  console.log(`[worker] ${signal}: shutting down`);
  // Fly escalates to SIGKILL after kill_timeout; exit on our own terms first.
  const force = setTimeout(() => {
    console.error("[worker] connections did not close in 10 s; exiting anyway");
    process.exit(1);
  }, 10_000);
  force.unref();
  // close() stops accepting and drops idle keep-alive sockets; in-flight requests finish.
  server.close((err) => {
    clearTimeout(force);
    process.exit(err ? 1 : 0);
  });
}
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
