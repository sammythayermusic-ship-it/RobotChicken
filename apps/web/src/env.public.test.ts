import { describe, expect, it } from "vitest";
import { loadWebPublicEnv } from "@cockfight/shared/env";
import { browserEnv } from "./env.public";

describe("browser env (no zod in the browser)", () => {
  it("applies exactly the schema's defaults", () => {
    const cases = [
      {},
      { NEXT_PUBLIC_GAME_WS_URL: "wss://cockfight-game.fly.dev", NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_x" },
      { NEXT_PUBLIC_TURNSTILE_SITE_KEY: "  ", NEXT_PUBLIC_COCK_MINT: "So11111111111111111111111111111111111111112" },
    ];
    for (const c of cases) {
      const raw = { NEXT_PUBLIC_GAME_WS_URL: undefined, NEXT_PUBLIC_COCK_MINT: undefined, NEXT_PUBLIC_TURNSTILE_SITE_KEY: undefined, NEXT_PUBLIC_SUPABASE_URL: undefined, NEXT_PUBLIC_SUPABASE_ANON_KEY: undefined, ...c };
      expect(browserEnv(raw)).toEqual(loadWebPublicEnv(raw));
    }
  });
});
