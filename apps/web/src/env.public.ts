/**
 * Public (browser-visible) env, parsed once with the shared zod schema.
 *
 * Every NEXT_PUBLIC_ value is referenced literally: Next inlines
 * `process.env.NEXT_PUBLIC_X` at build time only when it sees that exact
 * expression, so a dynamic `process.env[key]` would come back empty in the
 * browser. Unset or empty values fall back to the schema's local-dev defaults.
 */
import { loadWebPublicEnv } from "@cockfight/shared/env";

export const publicEnv = loadWebPublicEnv({
  NEXT_PUBLIC_GAME_WS_URL: process.env.NEXT_PUBLIC_GAME_WS_URL,
  NEXT_PUBLIC_COCK_MINT: process.env.NEXT_PUBLIC_COCK_MINT,
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY,
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
});
