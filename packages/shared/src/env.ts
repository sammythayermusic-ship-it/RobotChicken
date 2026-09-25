/**
 * Environment schemas. Every process boots with ZERO env vars in local dev:
 * anything a feature needs later is optional here and checked with
 * `requireEnv` at that feature's entry point, not at boot.
 *
 * `.env.example` at the repo root documents the full list from the spec.
 */
import { z } from "zod";

/** Drop empty / whitespace-only values so `FOO=` falls through to `.default()`. */
export function clean(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    const t = v?.trim();
    if (t) out[k] = t;
  }
  return out;
}

const base58 = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "not a base58 address");
const port = (d: number) => z.coerce.number().int().min(1).max(65535).default(d);

const common = {
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  SOLANA_CLUSTER: z.enum(["devnet", "mainnet-beta", "localnet"]).default("devnet"),
  NEXT_PUBLIC_COCK_MINT: base58.optional(),
  SUPABASE_URL: z.url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
};

export const gameEnv = z.object({
  ...common,
  PORT: port(2567),
  FLY_REGION: z.string().default("local"),
  ALLOWED_ORIGINS: z
    .string()
    .default("http://localhost:3000")
    .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean)),
  // Entry gate in USD; tierForUsd(usd, GATE_USD_MIN) keeps tiers and gate consistent.
  GATE_USD_MIN: z.coerce.number().positive().default(30),
  /**
   * "required": the wallet gate (Turnstile + $COCK balance) guards the queue
   * and results go to Supabase. "open": anyone queues with a name (playtests
   * before the coin exists); open matches never touch the database. Defaults
   * to required in production and open everywhere else (see loadGameEnv).
   */
  GATE_MODE: z.enum(["open", "required"]).optional(),
  /** Signs queue tokens (HS256). Unset: a random per-process secret (one machine only). */
  QUEUE_JWT_SECRET: z.string().min(32).optional(),
  /** Salts the IP / fingerprint hashes the caps count by (defaults to QUEUE_JWT_SECRET). */
  ANTI_ABUSE_SALT: z.string().min(16).optional(),
  /** Ranked pairing waits for this many tickets (spec: 4, so two colluding wallets can't be sure to meet). */
  QUEUE_MIN_PLAYERS: z.coerce.number().int().min(2).default(2),
  /** Two wallets are not paired again within this long (spec: 2 minutes). */
  REMATCH_COOLDOWN_S: z.coerce.number().int().nonnegative().default(120),
  /** /admin: off unless set (Fly secret). Basic auth, any username. */
  ADMIN_PASSWORD: z.string().min(16).optional(),
  /** /admin: only these client IPs (comma-separated); empty = any IP with the password. */
  ADMIN_ALLOWED_IPS: z
    .string()
    .default("")
    .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean)),
  REDIS_URL: z.url().optional(),
  HELIUS_API_KEY: z.string().optional(),
  /** Overrides the Helius RPC URL built from HELIUS_API_KEY (e.g. a local validator). */
  SOLANA_RPC_URL: z.url().optional(),
  JUPITER_PRICE_URL: z.url().default("https://api.jup.ag/price/v3"),
  JUPITER_API_KEY: z.string().optional(),
  /**
   * Devnet / localnet only: a fixed USD price per whole token, because no
   * price API quotes a devnet test mint. Ignored on mainnet.
   */
  GATE_FIXED_PRICE_USD: z.coerce.number().positive().optional(),
  /**
   * Turnstile secret. Outside production it defaults to Cloudflare's
   * always-pass test secret; in production an unset secret closes the gate
   * (POST /gate answers 503) rather than silently skipping the bot check.
   */
  TURNSTILE_SECRET_KEY: z.string().optional(),
});
/** Parsed game env; GATE_MODE is resolved from NODE_ENV when unset. */
export type GameEnv = Omit<z.infer<typeof gameEnv>, "GATE_MODE"> & { GATE_MODE: "open" | "required" };

/**
 * The worker: fee claims, the pool, payouts. Everything is optional so the
 * process boots with nothing (health only); with Supabase it computes the
 * pool ("observer"); with the hot wallet key and PAYOUTS_ENABLED it pays.
 */
const usd = (d: number) => z.coerce.number().nonnegative().default(d);
export const workerEnv = z.object({
  ...common,
  PORT: port(8080),
  FLY_REGION: z.string().default("local"),
  // Global kill switch for payouts. z.stringbool: "false" parses as false (z.coerce.boolean would say true).
  PAYOUTS_ENABLED: z.stringbool().default(false),
  HELIUS_API_KEY: z.string().optional(),
  SOLANA_RPC_URL: z.url().optional(),
  JUPITER_PRICE_URL: z.url().default("https://api.jup.ag/price/v3"),
  JUPITER_API_KEY: z.string().optional(),
  /** Public addresses (documentation and sanity checks; the keys below must match). */
  LAUNCH_WALLET: base58.optional(),
  HOT_WALLET: base58.optional(),
  SEED_WALLET: base58.optional(),
  COLD_WALLET: base58.optional(),
  /** Secret keys (Fly secrets only): base58 or a JSON byte array, 64 or 32 bytes. */
  HOT_WALLET_KEYPAIR: z.string().optional(),
  SEED_WALLET_KEYPAIR: z.string().optional(),
  /** The coin whose creator fees are claimed, and the token they arrive in and are paid in (PUMP). */
  COCK_MINT: base58.optional(),
  PAYOUT_MINT: base58.optional(),
  MAX_PAYOUT_USD: usd(500),
  MAX_DAILY_REWARD_USD: usd(5000),
  MAX_HOURLY_USD: usd(3000),
  MAX_DAILY_USD: usd(20000),
  PAYOUT_P_MIN_USD: usd(0.75),
  PAYOUT_P_MAX_USD: usd(75),
  PAYOUT_W_FLOOR: z.coerce.number().positive().default(200),
  PLAYER_SHARE_BPS: z.coerce.number().int().min(1).max(10000).default(7000),
  DAILY_POOL_BPS: z.coerce.number().int().min(0).max(10000).default(2000),
  /** Rust, Chrome, Gold multipliers. */
  TIER_WEIGHTS: z
    .string()
    .default("1,2.5,6")
    .transform((s, ctx) => {
      const w = s.split(",").map((x) => Number(x.trim()));
      if (w.length !== 3 || w.some((x) => !Number.isFinite(x) || x <= 0)) {
        ctx.addIssue({ code: "custom", message: "TIER_WEIGHTS must be three positive numbers: rust,chrome,gold" });
        return z.NEVER;
      }
      return w as [number, number, number];
    }),
  SEED_DAILY_DRAW_DIVISOR: z.coerce.number().min(1).default(14),
  GUARANTEED_WIN_BUDGET_USD: usd(0),
  GUARANTEED_DAILY_POOL_USD: usd(0),
  /** Priority fee per compute unit (micro-lamports). */
  PRIORITY_FEE_MICROLAMPORTS: z.coerce.number().int().nonnegative().default(100000),
  /** Minutes between creator-fee claims (each one costs ~0.000006 SOL; skipped when nothing is waiting). */
  CLAIM_EVERY_MIN: z.coerce.number().int().min(1).max(60).default(10),
});
export type WorkerEnv = z.infer<typeof workerEnv>;

export const webPublicEnv = z.object({
  NEXT_PUBLIC_GAME_WS_URL: z.url().default("ws://localhost:2567"),
  NEXT_PUBLIC_COCK_MINT: base58.optional(),
  // Cloudflare's documented always-pass test key; production must override it.
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: z.string().default("1x00000000000000000000AA"),
  NEXT_PUBLIC_SUPABASE_URL: z.url().optional(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().optional(),
});
export type WebPublicEnv = z.infer<typeof webPublicEnv>;

type EnvSource = Record<string, string | undefined>;
/**
 * In local dev the web app's port may move (WEB_PORT=3001 pnpm dev when 3000 is
 * taken); unless ALLOWED_ORIGINS is set explicitly, allow that port's origin.
 */
export const loadGameEnv = (e: EnvSource): GameEnv => {
  const env = clean(e);
  if (!env.ALLOWED_ORIGINS && env.WEB_PORT && /^\d+$/.test(env.WEB_PORT)) {
    env.ALLOWED_ORIGINS = `http://localhost:${env.WEB_PORT},http://127.0.0.1:${env.WEB_PORT}`;
  }
  const parsed = gameEnv.parse(env);
  return { ...parsed, GATE_MODE: parsed.GATE_MODE ?? (parsed.NODE_ENV === "production" ? "required" : "open") };
};
export const loadWorkerEnv = (e: EnvSource): WorkerEnv => workerEnv.parse(clean(e));
export const loadWebPublicEnv = (e: EnvSource): WebPublicEnv => webPublicEnv.parse(clean(e));

/** Throw a single readable error listing every missing key. Call at a feature's entry point. */
export function requireEnv<T extends object>(env: T, keys: readonly (keyof T & string)[], feature: string): void {
  const missing = keys.filter((k) => env[k] === undefined || env[k] === "");
  if (missing.length) throw new Error(`${feature} needs env: ${missing.join(", ")}`);
}
