/**
 * Process-wide services the rooms use. Colyseus keeps its matchmaker and room
 * registry in module-level singletons (one server per process), so the rooms
 * read these the same way; makeServer() installs them.
 */
import type { GameEnv } from "@cockfight/shared/env";
import { AbuseIds } from "./abuse";
import { GateService } from "./gate";
import { MemoryStore, SupabaseStore, type RatingStore } from "./results";

export interface GameContext {
  env: GameEnv;
  region: string;
  /** Every match (open and ranked) for /api/matches and the open leaderboard. */
  memory: MemoryStore;
  /** Ranked results: Supabase when configured, else the memory store. */
  ranked: RatingStore;
  supabase: SupabaseStore | null;
  gate: GateService;
  /** Salted IP / fingerprint hashes for the caps and pairing rules. */
  abuse: AbuseIds;
}

let current: GameContext | null = null;

export function setContext(ctx: GameContext): void {
  current = ctx;
}

export function getContext(): GameContext {
  if (!current) throw new Error("game context not set: build the server with makeServer()");
  return current;
}

export interface ContextOverrides {
  /** Network access for the gate and Supabase (tests pass a fake). */
  fetch?: typeof fetch;
  gate?: GateService;
}

export function buildContext(env: GameEnv, o: ContextOverrides = {}): GameContext {
  const memory = new MemoryStore();
  const supabase =
    env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY
      ? new SupabaseStore({ url: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_ROLE_KEY, fetch: o.fetch })
      : null;
  const gate = o.gate ?? new GateService(env, supabase, o.fetch ?? fetch);
  // Ranked results need the database; open playtests never touch it.
  const abuse = new AbuseIds(env.ANTI_ABUSE_SALT ?? env.QUEUE_JWT_SECRET);
  return { env, region: env.FLY_REGION, memory, ranked: supabase ?? memory, supabase, gate, abuse };
}
