/**
 * The entry gate: how much $COCK (in USD) a pasted wallet holds.
 *
 * - Balance: every token account the owner has for the mint, summed in raw
 *   base units (getTokenAccountsByOwner with a mint filter; the RPC resolves
 *   the mint's token program, so Token-2022 mints work too).
 * - Price: the LOWER of the configured sources (spec: "the lower of Jupiter
 *   and the bonding-curve quote"), so a thin or manipulated quote can't open
 *   the gate. On devnet a fixed configured price stands in, because no price
 *   API quotes a devnet test mint.
 * - Cache: 60 s per address for a pass (spec); a failed check isn't cached,
 *   so a player who just bought can retry at once. The match-start re-check
 *   bypasses the cache.
 *
 * Network access is injected (`fetch`), so tests run offline.
 */
import { tierForUsd, type Tier } from "@cockfight/shared";

export type PriceSourceName = "jupiter" | "curve" | "fixed";

export interface Holding {
  /** Raw base units (u64 amounts summed). */
  raw: bigint;
  decimals: number;
}

export interface BalanceReader {
  holding(owner: string, mint: string): Promise<Holding>;
}

export interface PriceQuote {
  source: PriceSourceName;
  /** USD per whole token. */
  usd: number;
}

export interface PriceReader {
  readonly name: PriceSourceName;
  /** USD per whole token, or null when this source has no price for the mint. */
  usdPrice(mint: string): Promise<number | null>;
}

export interface GateCheck {
  ok: boolean;
  address: string;
  usd: number;
  tokensRaw: bigint;
  decimals: number;
  tier: Tier | null;
  source: PriceSourceName;
  /** USD still missing to pass (0 when ok). */
  shortUsd: number;
  checkedAt: number;
  cached: boolean;
}

type Fetch = typeof fetch;

/** Solana JSON-RPC balance reader (Helius or any RPC). */
export class RpcBalanceReader implements BalanceReader {
  private readonly url: string;
  private readonly f: Fetch;
  constructor(url: string, f: Fetch = fetch) {
    this.url = url;
    this.f = f;
  }

  async holding(owner: string, mint: string): Promise<Holding> {
    const res = await this.f(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTokenAccountsByOwner",
        params: [owner, { mint }, { encoding: "jsonParsed", commitment: "confirmed" }],
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`rpc getTokenAccountsByOwner: HTTP ${res.status}`);
    const body = (await res.json()) as {
      error?: { message?: string };
      result?: { value?: { account?: { data?: { parsed?: { info?: { tokenAmount?: { amount?: string; decimals?: number } } } } } }[] };
    };
    if (body.error) throw new Error(`rpc getTokenAccountsByOwner: ${body.error.message ?? "error"}`);
    let raw = 0n;
    let decimals = -1;
    for (const acc of body.result?.value ?? []) {
      const amt = acc.account?.data?.parsed?.info?.tokenAmount;
      if (!amt || typeof amt.amount !== "string" || !/^\d+$/.test(amt.amount)) continue;
      raw += BigInt(amt.amount);
      if (typeof amt.decimals === "number") decimals = amt.decimals;
    }
    return { raw, decimals: decimals < 0 ? 0 : decimals };
  }
}

/** Jupiter Price API v3: `GET <url>?ids=<mint>` → `{ [mint]: { usdPrice } }`. */
export class JupiterPrice implements PriceReader {
  readonly name = "jupiter" as const;
  private readonly url: string;
  private readonly apiKey: string | undefined;
  private readonly f: Fetch;
  constructor(url: string, apiKey?: string, f: Fetch = fetch) {
    this.url = url;
    this.apiKey = apiKey;
    this.f = f;
  }

  async usdPrice(mint: string): Promise<number | null> {
    const res = await this.f(`${this.url}?ids=${encodeURIComponent(mint)}`, {
      headers: this.apiKey ? { "x-api-key": this.apiKey } : {},
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`jupiter price: HTTP ${res.status}`);
    const body = (await res.json()) as Record<string, { usdPrice?: unknown; price?: unknown } | null> & { data?: Record<string, { price?: unknown }> };
    // v3 is keyed by mint at the top level; v2 nested it under data with a string price.
    const entry = body[mint] ?? body.data?.[mint] ?? null;
    const p = Number(entry && ("usdPrice" in entry ? entry.usdPrice : entry.price));
    return Number.isFinite(p) && p > 0 ? p : null;
  }
}

/** A configured price (devnet test mints have no market). */
export class FixedPrice implements PriceReader {
  readonly name = "fixed" as const;
  private readonly usd: number;
  constructor(usd: number) {
    this.usd = usd;
  }
  async usdPrice(): Promise<number | null> {
    return this.usd;
  }
}

export interface GateOptions {
  mint: string;
  balances: BalanceReader;
  /** At least one. The gate uses the lowest price any of them returns. */
  prices: PriceReader[];
  gateUsd: number;
  cacheMs?: number;
  now?: () => number;
}

export class BalanceGate {
  private readonly o: Required<Omit<GateOptions, "now">> & { now: () => number };
  private readonly cache = new Map<string, GateCheck>();

  constructor(o: GateOptions) {
    if (o.prices.length === 0) throw new Error("BalanceGate: at least one price source");
    this.o = { cacheMs: 60_000, now: Date.now, ...o };
  }

  get gateUsd(): number {
    return this.o.gateUsd;
  }

  async check(address: string, opts: { bypassCache?: boolean } = {}): Promise<GateCheck> {
    const now = this.o.now();
    const hit = this.cache.get(address);
    if (!opts.bypassCache && hit && now - hit.checkedAt < this.o.cacheMs) return { ...hit, cached: true };

    const [holding, quote] = await Promise.all([this.o.balances.holding(address, this.o.mint), this.lowestPrice()]);
    const usd = holdingUsd(holding, quote.usd);
    const tier = tierForUsd(usd, this.o.gateUsd);
    const res: GateCheck = {
      ok: tier !== null,
      address,
      usd,
      tokensRaw: holding.raw,
      decimals: holding.decimals,
      tier,
      source: quote.source,
      shortUsd: tier ? 0 : Math.max(0, this.o.gateUsd - usd),
      checkedAt: now,
      cached: false,
    };
    // Only passes are cached: someone under the gate who buys more can
    // retry at once instead of waiting out the cache.
    if (res.ok) this.cache.set(address, res);
    else this.cache.delete(address);
    if (this.cache.size > 10_000) this.prune(now);
    return res;
  }

  private async lowestPrice(): Promise<PriceQuote> {
    const got = await Promise.all(
      this.o.prices.map(async (p) => {
        try {
          const usd = await p.usdPrice(this.o.mint);
          return usd === null ? null : { source: p.name, usd };
        } catch {
          return null;
        }
      }),
    );
    const quotes = got.filter((q): q is PriceQuote => q !== null);
    if (quotes.length === 0) throw new Error("no price for the mint from any source");
    return quotes.reduce((a, b) => (b.usd < a.usd ? b : a));
  }

  private prune(now: number): void {
    for (const [k, v] of this.cache) if (now - v.checkedAt >= this.o.cacheMs) this.cache.delete(k);
  }
}

/**
 * USD value of a raw holding. A float is fine here: the gate compares dollars,
 * and a double's 1e-16 relative error is far below a cent. (Scaling the price
 * to integer micro-dollars instead would round a memecoin's $0.0000003 to 0.)
 */
export function holdingUsd(h: Holding, usdPerToken: number): number {
  if (h.raw === 0n) return 0;
  return (Number(h.raw) / 10 ** h.decimals) * usdPerToken;
}
