/**
 * The entry gate on the game server: POST /gate checks Turnstile and the
 * pasted wallet's $COCK, and hands back a queue token; the queue re-checks
 * both players (cache bypass) right before a match.
 *
 * It lives here rather than in a Vercel API route (the spec's diagram) so the
 * Helius key sits in one place, the match-start re-check needs no extra hop,
 * and the web app can stay a static site (docs/decisions.md).
 */
import { BalanceGate, FixedPrice, JupiterPrice, RpcBalanceReader, isWalletAddress, type GateCheck, type PriceReader } from "@cockfight/solana";
import type { GameEnv } from "@cockfight/shared/env";
import type { Tier } from "@cockfight/shared";
import { QueueTokens } from "./token";
import { TURNSTILE_TEST_SECRET, verifyTurnstile } from "./turnstile";
import type { SupabaseStore } from "./results";

export type GateMode = "open" | "required";

export interface GateConfig {
  gate: GateMode;
  gateUsd: number;
  mint: string | null;
  cluster: string;
  region: string;
}

export type GateResponse =
  | { status: 200; body: { ok: true; usd: number; tier: Tier; token: string; elo: number | null } }
  | { status: 200; body: { ok: false; usd: number; shortUsd: number; gateUsd: number } }
  | { status: 400 | 403 | 409 | 429 | 502 | 503; body: { ok: false; error: string; message: string } };

const fail = (status: 400 | 403 | 409 | 429 | 502 | 503, error: string, message: string): GateResponse => ({ status, body: { ok: false, error, message } });

export class GateService {
  readonly mode: GateMode;
  readonly tokens: QueueTokens;
  readonly balance: BalanceGate | null;
  private readonly env: GameEnv;
  private readonly supabase: SupabaseStore | null;
  private readonly f: typeof fetch;
  private readonly hits = new Map<string, number[]>();
  /** Null: Turnstile isn't configured (production without a secret), so the gate stays shut. */
  private readonly turnstileSecret: string | null;
  /** In production, the hostnames a Turnstile token must come from (the web app's). */
  private readonly turnstileHosts: string[] | undefined;

  constructor(env: GameEnv, supabase: SupabaseStore | null, f: typeof fetch = fetch, balance?: BalanceGate | null) {
    this.env = env;
    this.mode = env.GATE_MODE;
    this.supabase = supabase;
    this.f = f;
    this.tokens = new QueueTokens(env.QUEUE_JWT_SECRET);
    this.balance = balance === undefined ? buildBalanceGate(env, f) : balance;
    this.turnstileSecret = env.TURNSTILE_SECRET_KEY ?? (env.NODE_ENV === "production" ? null : TURNSTILE_TEST_SECRET);
    this.turnstileHosts = env.NODE_ENV === "production" && env.TURNSTILE_SECRET_KEY ? env.ALLOWED_ORIGINS.map((o) => new URL(o).hostname) : undefined;
  }

  config(): GateConfig {
    return {
      gate: this.mode,
      gateUsd: this.env.GATE_USD_MIN,
      mint: this.env.NEXT_PUBLIC_COCK_MINT ?? null,
      cluster: this.env.SOLANA_CLUSTER,
      region: this.env.FLY_REGION,
    };
  }

  /** POST /gate. */
  async enter(body: unknown, ip: string | null): Promise<GateResponse> {
    if (this.mode === "open") return fail(409, "open", "The gate is open: queue with a name.");
    if (!this.allow(ip)) return fail(429, "slow_down", "Too many checks. Wait a minute and try again.");
    const b = (typeof body === "object" && body !== null ? body : {}) as { address?: unknown; turnstile?: unknown };
    const address = typeof b.address === "string" ? b.address.trim() : "";
    if (!isWalletAddress(address)) return fail(400, "address", "That isn't a Solana wallet address.");
    if (!this.turnstileSecret) return fail(503, "not_configured", "The wallet gate isn't set up on this server yet.");
    if (!(await verifyTurnstile(this.turnstileSecret, b.turnstile, ip, this.f, this.turnstileHosts))) {
      return fail(403, "turnstile", "The bot check failed. Try again.");
    }
    if (!this.balance) return fail(503, "not_configured", "The wallet gate isn't set up on this server yet.");
    let check: GateCheck;
    try {
      check = await this.balance.check(address);
    } catch (e) {
      console.warn("[gate] balance check failed:", e instanceof Error ? e.message : e);
      return fail(502, "chain", "Couldn't read the wallet right now. Try again in a moment.");
    }
    const elo = await this.audit(check);
    if (!check.ok || !check.tier) {
      return { status: 200, body: { ok: false, usd: round2(check.usd), shortUsd: round2(check.shortUsd), gateUsd: this.env.GATE_USD_MIN } };
    }
    const token = this.tokens.sign({ sub: address, tier: check.tier, usd: round2(check.usd), elo });
    return { status: 200, body: { ok: true, usd: round2(check.usd), tier: check.tier, token, elo } };
  }

  /** The match-start re-check (cache bypass). Null when the gate can't answer (the match then goes ahead on the queue token). */
  async recheck(address: string): Promise<GateCheck | null> {
    if (!this.balance) return null;
    try {
      const c = await this.balance.check(address, { bypassCache: true });
      void this.audit(c);
      return c;
    } catch (e) {
      console.warn("[gate] re-check failed:", e instanceof Error ? e.message : e);
      return null;
    }
  }

  /** balance_checks row (and the player's tier) in Supabase; the rating back. Best effort. */
  private async audit(c: GateCheck): Promise<number | null> {
    if (!this.supabase || c.cached) return null;
    try {
      return await this.supabase.recordGate({ address: c.address, usd: c.usd, tokensRaw: c.tokensRaw, decimals: c.decimals, source: c.source, tier: c.tier });
    } catch (e) {
      console.warn("[gate] could not record the check:", e instanceof Error ? e.message : e);
      return null;
    }
  }

  /** 20 checks per IP (IPv6: per /64) per minute. */
  private allow(ip: string | null): boolean {
    const key = ipBucket(ip);
    const now = Date.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= 20) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 20_000) {
      // Forget idle IPs only; active limits stay in force.
      for (const [k, v] of this.hits) if (v.every((t) => now - t >= 60_000)) this.hits.delete(k);
    }
    return true;
  }
}

/** The balance gate from env, or null when the mint or an RPC isn't configured. */
export function buildBalanceGate(env: GameEnv, f: typeof fetch = fetch): BalanceGate | null {
  const mint = env.NEXT_PUBLIC_COCK_MINT;
  const rpc = env.SOLANA_RPC_URL ?? (env.HELIUS_API_KEY ? heliusUrl(env.SOLANA_CLUSTER, env.HELIUS_API_KEY) : null);
  if (!mint || !rpc) return null;
  const prices: PriceReader[] = [];
  if (env.SOLANA_CLUSTER !== "mainnet-beta" && env.GATE_FIXED_PRICE_USD) prices.push(new FixedPrice(env.GATE_FIXED_PRICE_USD));
  else prices.push(new JupiterPrice(env.JUPITER_PRICE_URL, env.JUPITER_API_KEY, f));
  // Phase 3 adds the launchpad's bonding-curve quote here (the gate takes the lower price).
  return new BalanceGate({ mint, balances: new RpcBalanceReader(rpc, f), prices, gateUsd: env.GATE_USD_MIN });
}

function heliusUrl(cluster: string, key: string): string {
  const host = cluster === "mainnet-beta" ? "mainnet.helius-rpc.com" : "devnet.helius-rpc.com";
  return `https://${host}/?api-key=${encodeURIComponent(key)}`;
}

/**
 * The player's IP. On Fly (FLY_APP_NAME is set) only Fly-Client-IP counts:
 * Fly's proxy sets it, while X-Forwarded-For can carry whatever the client
 * sent. Elsewhere (local dev, tests) the first forwarded hop is used.
 */
export function clientIp(headers: Headers, onFly: boolean = !!process.env.FLY_APP_NAME): string | null {
  const fly = headers.get("fly-client-ip");
  if (fly) return fly.trim();
  if (onFly) return null;
  const fwd = headers.get("x-forwarded-for");
  if (fwd) return (fwd.split(",")[0] ?? "").trim() || null;
  return null;
}

/** Rate-limit key: the IPv4 address, or the /64 of an IPv6 one (one customer usually gets a whole /64). */
export function ipBucket(ip: string | null): string {
  if (!ip) return "?";
  if (!ip.includes(":")) return ip;
  const parts = ip.split("::")[0]!.split(":");
  return `${parts.slice(0, 4).join(":")}::/64`;
}

const round2 = (x: number) => Math.floor(x * 100) / 100;
