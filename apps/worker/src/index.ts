/**
 * Worker entry point (`pnpm dev` via tsx, production via dist/worker.mjs).
 *
 * Three modes, by what env provides:
 *   health    no Supabase: /health only (Phase 0 behaviour).
 *   observer  Supabase + RPC + PAYOUT_MINT: the pool is recomputed every
 *             minute and the daily top 10 is booked at midnight, but nothing
 *             is sent (no hot key, or PAYOUTS_ENABLED=false).
 *   live      + HOT_WALLET_KEYPAIR and PAYOUTS_ENABLED=true: claims, payouts,
 *             the seed draw and sweeps too.
 */
import { Treasury } from "@cockfight/economy";
import { loadWorkerEnv } from "@cockfight/shared/env";
import { JupiterPrice, Keypair, SolanaRpc } from "@cockfight/solana";
import { SolanaChain } from "./chain";
import { SupabaseLedger } from "./ledger";
import { ObserverChain, WorkerLoop, type WorkerMode } from "./loop";
import { createWorkerServer, type WorkerStatus } from "./server";
import { applySettings, paramsFromEnv } from "./settings";
import { TelegramAlerts } from "./telegram";

const env = loadWorkerEnv(process.env);
const status: WorkerStatus = { ok: true, mode: "health", payoutsEnabled: false, startedAt: new Date().toISOString() };

const server = createWorkerServer(() => status);
server.on("error", (err) => {
  console.error("[worker] server error:", err);
  process.exit(1);
});
server.listen(env.PORT, "0.0.0.0", () => {
  console.log(`[worker] listening on 0.0.0.0:${env.PORT} region=${env.FLY_REGION}`);
});

let loop: WorkerLoop | null = null;

async function start(): Promise<void> {
  const rpcUrl = env.SOLANA_RPC_URL ?? (env.HELIUS_API_KEY ? `https://${env.SOLANA_CLUSTER === "devnet" ? "devnet" : "mainnet"}.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}` : null);
  const missing: string[] = [];
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) missing.push("SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY");
  if (!rpcUrl) missing.push("HELIUS_API_KEY or SOLANA_RPC_URL");
  if (!env.PAYOUT_MINT) missing.push("PAYOUT_MINT");
  if (missing.length) {
    console.log(`[worker] health only: set ${missing.join(", ")} to compute the pool`);
    return;
  }
  const alerts = new TelegramAlerts({ token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID });
  const ledger = new SupabaseLedger({ url: env.SUPABASE_URL as string, serviceKey: env.SUPABASE_SERVICE_ROLE_KEY as string });
  const rpc = new SolanaRpc(rpcUrl as string);
  const prices = new JupiterPrice(env.JUPITER_PRICE_URL, env.JUPITER_API_KEY);
  const params = paramsFromEnv(env);

  let mode: WorkerMode = "observer";
  let chain: SolanaChain | ObserverChain;
  const why: string[] = [];
  if (!env.PAYOUTS_ENABLED) why.push("PAYOUTS_ENABLED is false");
  if (!env.HOT_WALLET_KEYPAIR) why.push("HOT_WALLET_KEYPAIR is not set");
  if (why.length === 0) {
    const hot = Keypair.fromSecret(env.HOT_WALLET_KEYPAIR as string);
    if (env.HOT_WALLET && hot.publicKey !== env.HOT_WALLET) throw new Error(`HOT_WALLET_KEYPAIR is for ${hot.publicKey}, not HOT_WALLET ${env.HOT_WALLET}`);
    const seed = env.SEED_WALLET_KEYPAIR ? Keypair.fromSecret(env.SEED_WALLET_KEYPAIR) : undefined;
    if (seed && env.SEED_WALLET && seed.publicKey !== env.SEED_WALLET) throw new Error(`SEED_WALLET_KEYPAIR is for ${seed.publicKey}, not SEED_WALLET ${env.SEED_WALLET}`);
    chain = new SolanaChain({
      rpc, hot, seed, cold: env.COLD_WALLET, payoutMint: env.PAYOUT_MINT as string, cockMint: env.COCK_MINT, prices,
      priorityMicroLamports: BigInt(env.PRIORITY_FEE_MICROLAMPORTS),
    });
    mode = "live";
    console.log(`[worker] live: hot=${hot.publicKey} seed=${seed?.publicKey ?? "(none)"} cold=${env.COLD_WALLET ?? "(none)"} cock=${env.COCK_MINT ?? "(no claims)"} payout=${env.PAYOUT_MINT}`);
  } else {
    chain = new ObserverChain(rpc, prices, env.PAYOUT_MINT as string);
    console.log(`[worker] observer: ${why.join("; ")}. The pool is computed, nothing is sent.`);
  }
  await chain.init();
  const treasury = new Treasury({ params, ledger, chain, alerts, drawSeed: mode === "live" && !!(chain as SolanaChain).seed, autoTopUp: mode === "live" });
  loop = new WorkerLoop({
    treasury, ledger, mode, status, claimEveryMin: env.CLAIM_EVERY_MIN,
    reloadParams: async () => treasury.updateParams(applySettings(params, await ledger.settings())),
  });
  await loop.start();
}

start().catch((e) => {
  console.error("[worker] failed to start:", e);
  status.ok = false;
  status.error = e instanceof Error ? e.message : String(e);
});

let stopping = false;
function shutdown(signal: NodeJS.Signals): void {
  if (stopping) return;
  stopping = true;
  console.log(`[worker] ${signal}: shutting down`);
  loop?.stop();
  const force = setTimeout(() => {
    console.error("[worker] did not finish in 20 s; exiting anyway");
    process.exit(1);
  }, 20_000);
  force.unref();
  void (loop?.drain() ?? Promise.resolve()).then(() => {
    server.close((err) => {
      clearTimeout(force);
      process.exit(err ? 1 : 0);
    });
  });
}
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
