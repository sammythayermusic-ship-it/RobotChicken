/**
 * Launch preflight: read-only checks that the live stack is set up for the
 * coin it should be running. Changes nothing; safe to run any time.
 *
 *   pnpm --filter @cockfight/tools launch:preflight -- <mint> [--launch]
 *
 * <mint> is the coin the stack should be on (defaults to whatever the game
 * server reports). --launch also demands the launch-day values: $30 gate,
 * funding-day secrets, Jupiter key. Keys are read from .env.local and Fly;
 * no secret is printed.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CurvePrice, JupiterPrice, SolanaRpc, decodeBondingCurve, decodeSharingConfig, pumpPda } from "@cockfight/solana";

const repo = resolve(import.meta.dirname, "../..");
const GAME = "https://cockfight-game.fly.dev";
const SITE = "https://cockfightsol.fun";
const PUMP = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
// The wallets are whatever the worker is deployed with (apps/worker/fly.toml [env]).
const workerToml = readFileSync(resolve(repo, "apps/worker/fly.toml"), "utf8");
const tomlEnv = (k: string) => new RegExp(`^\\s*${k}\\s*=\\s*"([^"]+)"`, "m").exec(workerToml)?.[1] ?? "";
const HOT = tomlEnv("HOT_WALLET");
const LAUNCH = tomlEnv("LAUNCH_WALLET");
const TEST_COIN = "HFypaAkLk4XwKJvLK5hTvL65dhY2F61davhjo1x8pump";

const args = process.argv.slice(2).filter((a) => a !== "--");
const launch = args.includes("--launch");
let mint = args.find((a) => !a.startsWith("--")) ?? "";

let fails = 0;
let warns = 0;
const line = (mark: string, what: string, detail = "") => console.log(`${mark} ${what}${detail ? ` · ${detail}` : ""}`);
const pass = (w: string, d = "") => line("✅", w, d);
const fail = (w: string, d = "") => (fails++, line("❌", w, d));
const warn = (w: string, d = "") => (warns++, line("⚠️ ", w, d));
const check = (ok: boolean, w: string, d = "", soft = false) => (ok ? pass(w, d) : soft ? warn(w, d) : fail(w, d));

function envLocal(): Record<string, string> {
  try {
    const out: Record<string, string> = {};
    for (const l of readFileSync(resolve(repo, ".env.local"), "utf8").split("\n")) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
      if (m) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
    }
    return out;
  } catch {
    return {};
  }
}

function flySecrets(app: string): Set<string> {
  try {
    const j = JSON.parse(execFileSync("fly", ["secrets", "list", "-a", app, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })) as { Name?: string; name?: string }[];
    return new Set(j.map((s) => s.Name ?? s.name ?? ""));
  } catch {
    return new Set(["<fly unavailable>"]);
  }
}

async function json(url: string): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    return r.ok ? ((await r.json()) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

console.log(`COCKFIGHT preflight${launch ? " (launch day)" : ""}\n`);

// 1. Game server
console.log("Game server");
const health = await json(`${GAME}/health`);
check(health?.ok === true, "/health ok", health ? `rooms ${health.rooms}, ccu ${health.ccu}` : "unreachable");
const cfg = await json(`${GAME}/config`);
if (!mint) mint = String(cfg?.mint ?? "");
check(cfg?.gate === "required", "wallet gate required", `gate=${cfg?.gate}`);
check(cfg?.mint === mint, "game server on the expected coin", String(cfg?.mint));
check(cfg?.cluster === "mainnet-beta", "mainnet", String(cfg?.cluster));
check(!launch || cfg?.gateUsd === 30, "entry gate", `$${cfg?.gateUsd}${launch ? " (launch wants $30)" : ""}`, !launch);
if (launch) check(mint !== TEST_COIN, "not the throwaway test coin", mint);
const gameSecrets = flySecrets("cockfight-game");
for (const k of ["NEXT_PUBLIC_COCK_MINT", "GATE_USD_MIN", "HELIUS_API_KEY", "TURNSTILE_SECRET_KEY", "QUEUE_JWT_SECRET", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "ADMIN_PASSWORD"])
  check(gameSecrets.has(k), `game secret ${k}`);
check(gameSecrets.has("JUPITER_API_KEY"), "game secret JUPITER_API_KEY", "keyless Jupiter is rate-limited", !launch);

// 2. Worker
console.log("\nWorker");
const workerSecrets = flySecrets("cockfight-worker");
for (const k of ["COCK_MINT", "PAYOUTS_ENABLED", "HOT_WALLET_KEYPAIR", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "HELIUS_API_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"])
  check(workerSecrets.has(k), `worker secret ${k}`);
check(workerSecrets.has("JUPITER_API_KEY"), "worker secret JUPITER_API_KEY", "keyless Jupiter is rate-limited", !launch);
try {
  const st = JSON.parse(execFileSync("fly", ["status", "-a", "cockfight-worker", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })) as { Machines?: { state?: string }[] };
  const states = (st.Machines ?? []).map((m) => m.state);
  check(states.length === 1 && states[0] === "started", "worker machine running", states.join(",") || "none (tools/launch/start-worker.sh)");
} catch {
  fail("worker machine running", "fly status failed");
}

// 3. Chain
console.log("\nChain");
const env = envLocal();
const rpcUrl = env.SOLANA_RPC_URL || (env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}` : "");
if (!rpcUrl || !mint) {
  fail("chain checks", rpcUrl ? "no mint" : "no HELIUS_API_KEY in .env.local");
} else {
  const rpc = new SolanaRpc(rpcUrl);
  const curveAcc = await rpc.getAccountInfo(pumpPda.bondingCurve(mint)).catch(() => null);
  if (!curveAcc) fail("pump.fun bonding curve", "not found for this mint");
  else {
    const c = decodeBondingCurve(curveAcc.data);
    check(c.quoteMint === PUMP, "paired to PUMP", c.quoteMint);
    check(c.creator === pumpPda.sharingConfig(mint) || c.creator === LAUNCH, "creator is the launch wallet or its fee-sharing config", c.creator);
    pass("curve state", c.complete ? "graduated (Jupiter alone prices it)" : "on the bonding curve");
  }
  const share = await rpc.getAccountInfo(pumpPda.sharingConfig(mint)).catch(() => null);
  if (!share) fail("creator-reward sharing", "no sharing config: turn on \"Share creator rewards\" 70 hot / 30 launch");
  else {
    const s = decodeSharingConfig(share.data);
    const bps = Object.fromEntries(s.shareholders.map((h) => [h.address, h.shareBps]));
    check(bps[HOT] === 7000 && bps[LAUNCH] === 3000 && s.shareholders.length === 2, "creator rewards 70% hot / 30% launch", s.shareholders.map((h) => `${h.address.slice(0, 4)}…=${h.shareBps / 100}%`).join(" "));
  }
  const jup = new JupiterPrice("https://api.jup.ag/price/v3", env.JUPITER_API_KEY || undefined);
  const [pj, pc] = await Promise.all([jup.usdPrice(mint).catch(() => null), new CurvePrice(rpc, jup).usdPrice(mint).catch(() => null)]);
  check(pj !== null || pc !== null, "the gate can price the coin", `Jupiter ${pj ?? "—"} · curve ${pc ?? "—"} USD/token`);
  const sol = async (a: string) => Number(await rpc.getBalance(a)) / 1e9;
  const hotSol = await sol(HOT).catch(() => -1);
  check(hotSol >= 0.1, "hot wallet SOL for fees", `${hotSol.toFixed(3)} SOL (keep ≥ 0.1)`, hotSol >= 0.03);
}

// 4. Site
console.log("\nSite");
try {
  const r = await fetch(SITE, { signal: AbortSignal.timeout(8000) });
  const html = await r.text();
  check(r.ok, `${SITE} up`, `HTTP ${r.status}`);
  check(/property="og:image"/.test(html), "link preview card (og:image)");
  check(!/noindex/i.test(r.headers.get("x-robots-tag") ?? ""), "search engines allowed", r.headers.get("x-robots-tag") ?? "no X-Robots-Tag", true);
} catch (e) {
  fail(`${SITE} up`, String(e));
}

console.log(`\n${fails ? `❌ ${fails} to fix` : "✅ all clear"}${warns ? ` · ⚠️  ${warns} to look at` : ""}`);
process.exit(fails ? 1 : 0);
