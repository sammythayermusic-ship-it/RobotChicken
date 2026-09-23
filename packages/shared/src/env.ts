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
  GATE_USD_MIN: z.coerce.number().positive().default(30),
  QUEUE_JWT_SECRET: z.string().min(32).optional(),
  REDIS_URL: z.url().optional(),
});
export type GameEnv = z.infer<typeof gameEnv>;

/** Phase 0 worker: a health stub. Money settings arrive with Phase 3. */
export const workerEnv = z.object({
  ...common,
  PORT: port(8080),
  FLY_REGION: z.string().default("local"),
  // Global kill switch for payouts. z.stringbool: "false" parses as false (z.coerce.boolean would say true).
  PAYOUTS_ENABLED: z.stringbool().default(false),
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
  return gameEnv.parse(env);
};
export const loadWorkerEnv = (e: EnvSource): WorkerEnv => workerEnv.parse(clean(e));
export const loadWebPublicEnv = (e: EnvSource): WebPublicEnv => webPublicEnv.parse(clean(e));

/** Throw a single readable error listing every missing key. Call at a feature's entry point. */
export function requireEnv<T extends object>(env: T, keys: readonly (keyof T & string)[], feature: string): void {
  const missing = keys.filter((k) => env[k] === undefined || env[k] === "");
  if (missing.length) throw new Error(`${feature} needs env: ${missing.join(", ")}`);
}
