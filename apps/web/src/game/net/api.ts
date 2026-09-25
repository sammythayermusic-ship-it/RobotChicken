/**
 * The game server's HTTP side: whether the gate is open, the wallet gate,
 * and (for open playtests, or when Supabase isn't configured) finished
 * matches and the leaderboard.
 */
import type { Tier } from "@cockfight/shared";
import { publicEnv } from "@/env.public";

export interface ServerConfig {
  gate: "open" | "required";
  gateUsd: number;
  mint: string | null;
  cluster: string;
  region: string;
}

export type GateAnswer =
  | { ok: true; usd: number; tier: Tier; token: string; elo: number | null; name?: string | null }
  | { ok: false; usd: number; shortUsd: number; gateUsd: number }
  | { ok: false; error: string; message: string };

/** ws(s)://host → http(s)://host (the SDK does the same for matchmaking). */
export function httpBase(wsUrl: string = publicEnv.NEXT_PUBLIC_GAME_WS_URL): string {
  const u = new URL(wsUrl);
  u.protocol = u.protocol === "wss:" ? "https:" : u.protocol === "ws:" ? "http:" : u.protocol;
  return u.origin;
}

export async function fetchConfig(base = httpBase()): Promise<ServerConfig> {
  const res = await fetch(`${base}/config`, { signal: AbortSignal.timeout(8000), cache: "no-store" });
  if (!res.ok) throw new Error(`game server /config: HTTP ${res.status}`);
  return (await res.json()) as ServerConfig;
}

/**
 * POST /gate as text/plain: a CORS "simple" request, so the browser sends no
 * preflight (one round trip, and nothing for the game server to answer twice).
 */
export async function postGate(address: string, turnstile: string, base = httpBase()): Promise<GateAnswer> {
  const res = await fetch(`${base}/gate`, {
    method: "POST",
    headers: { "content-type": "text/plain;charset=UTF-8" },
    body: JSON.stringify({ address, turnstile }),
    signal: AbortSignal.timeout(20_000),
  });
  try {
    return (await res.json()) as GateAnswer;
  } catch {
    return { ok: false, error: "server", message: `The game server answered ${res.status}.` };
  }
}

/** Round trip to the game server (ms), the best of a few /health requests. */
export async function probeRtt(base = httpBase(), tries = 3): Promise<number> {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < tries; i++) {
    const t0 = performance.now();
    try {
      const res = await fetch(`${base}/health`, { cache: "no-store", signal: AbortSignal.timeout(3000) });
      await res.body?.cancel();
      if (res.ok) best = Math.min(best, performance.now() - t0);
    } catch {
      // try again
    }
  }
  return Number.isFinite(best) ? Math.round(best) : 999;
}

export type UsernameAnswer = { ok: true; name: string } | { ok: false; error: string; message: string };

/** POST /username/nonce → the nonce the wallet signs (inside `cockfight:claim:<nonce>:<name>`). */
export async function postUsernameNonce(address: string, base = httpBase()): Promise<{ nonce: string } | { error: string; message: string }> {
  const res = await fetch(`${base}/username/nonce`, {
    method: "POST",
    headers: { "content-type": "text/plain;charset=UTF-8" },
    body: JSON.stringify({ address }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json().catch(() => ({ error: "server", message: `The game server answered ${res.status}.` }))) as { nonce?: string; error?: string; message?: string };
  return body.nonce ? { nonce: body.nonce } : { error: body.error ?? "server", message: body.message ?? "Couldn't get a nonce." };
}

/** POST /username with the wallet's signature over the claim message. */
export async function postUsername(o: { address: string; name: string; nonce: string; signature: string }, base = httpBase()): Promise<UsernameAnswer> {
  const res = await fetch(`${base}/username`, {
    method: "POST",
    headers: { "content-type": "text/plain;charset=UTF-8" },
    body: JSON.stringify(o),
    signal: AbortSignal.timeout(10_000),
  });
  try {
    return (await res.json()) as UsernameAnswer;
  } catch {
    return { ok: false, error: "server", message: `The game server answered ${res.status}.` };
  }
}

/** The claim message, exactly as the server checks it. */
export const claimMessage = (nonce: string, name: string): string => `cockfight:claim:${nonce}:${name}`;
