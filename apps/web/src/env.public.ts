/**
 * Public (browser-visible) env.
 *
 * Every NEXT_PUBLIC_ value is referenced literally: Next inlines
 * `process.env.NEXT_PUBLIC_X` at build time only when it sees that exact
 * expression, so a dynamic `process.env[key]` would come back empty in the
 * browser. Unset or empty values fall back to the schema's local-dev defaults.
 *
 * On the server (build, next.config, SSR) the values are validated with the
 * shared zod schema, so a bad URL fails the build. The browser gets the same
 * inlined values and only applies the defaults: parsing with zod there would
 * run zod's `new Function` probe, a CSP violation (script-src has no
 * 'unsafe-eval').
 */
import { loadWebPublicEnv, type WebPublicEnv } from "@cockfight/shared/env";

const raw = {
  NEXT_PUBLIC_GAME_WS_URL: process.env.NEXT_PUBLIC_GAME_WS_URL,
  NEXT_PUBLIC_COCK_MINT: process.env.NEXT_PUBLIC_COCK_MINT,
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY,
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
};

const set = (v: string | undefined): string | undefined => v?.trim() || undefined;

/** The schema's defaults (packages/shared/src/env.ts webPublicEnv), without zod. A test keeps them equal. */
export function browserEnv(r: typeof raw): WebPublicEnv {
  const out: WebPublicEnv = {
    NEXT_PUBLIC_GAME_WS_URL: set(r.NEXT_PUBLIC_GAME_WS_URL) ?? "ws://localhost:2567",
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: set(r.NEXT_PUBLIC_TURNSTILE_SITE_KEY) ?? "1x00000000000000000000AA",
  };
  const mint = set(r.NEXT_PUBLIC_COCK_MINT);
  const sbUrl = set(r.NEXT_PUBLIC_SUPABASE_URL);
  const sbKey = set(r.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  if (mint) out.NEXT_PUBLIC_COCK_MINT = mint;
  if (sbUrl) out.NEXT_PUBLIC_SUPABASE_URL = sbUrl;
  if (sbKey) out.NEXT_PUBLIC_SUPABASE_ANON_KEY = sbKey;
  return out;
}

export const publicEnv: WebPublicEnv = typeof window === "undefined" ? loadWebPublicEnv(raw) : browserEnv(raw);
