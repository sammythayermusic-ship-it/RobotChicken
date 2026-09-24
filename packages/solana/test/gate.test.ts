import { createHash } from "node:crypto";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { BalanceGate, FixedPrice, JupiterPrice, RpcBalanceReader, holdingUsd, isOnCurve, isWalletAddress, type PriceReader } from "../src/index";

const MINT = "So11111111111111111111111111111111111111112";
// A real wallet key (on the curve).
const WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

function rpcReturning(amounts: [string, number][]): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { value: amounts.map(([amount, decimals]) => ({ account: { data: { parsed: { info: { tokenAmount: { amount, decimals } } } } } })) },
      }),
    )) as typeof fetch;
}

function gateAt(pricePerToken: number, raw: string, decimals = 6, extra: PriceReader[] = []) {
  let calls = 0;
  const f = (async (...a: Parameters<typeof fetch>) => {
    calls++;
    return rpcReturning([[raw, decimals]])(...a);
  }) as typeof fetch;
  let now = 1_000_000;
  const gate = new BalanceGate({
    mint: MINT,
    balances: new RpcBalanceReader("http://rpc", f),
    prices: [new FixedPrice(pricePerToken), ...extra],
    gateUsd: 30,
    now: () => now,
  });
  return { gate, calls: () => calls, advance: (ms: number) => (now += ms) };
}

describe("wallet addresses", () => {
  it("accepts keys on the ed25519 curve", () => {
    expect(isOnCurve(WALLET)).toBe(true);
    expect(isWalletAddress(WALLET)).toBe(true);
    expect(isWalletAddress("not an address")).toBe(false);
  });

  it("refuses off-curve addresses: about half of all 32-byte strings, like PDAs", () => {
    // Program-derived addresses are sha256 outputs that happen to be off the
    // curve; roughly half of arbitrary 32-byte strings decode to no point.
    let off = 0;
    for (let i = 0; i < 400; i++) {
      const bytes = createHash("sha256").update(`cockfight-${i}`).digest();
      if (!isOnCurve(bs58.encode(bytes))) off++;
    }
    expect(off).toBeGreaterThan(140);
    expect(off).toBeLessThan(260);
  });
});

describe("BalanceGate", () => {
  it("blocks a wallet at $29 and admits one at $31 (spec acceptance)", async () => {
    // 29 and 31 whole tokens at $1, 6 decimals.
    expect(await gateAt(1, "29000000").gate.check(WALLET)).toMatchObject({ ok: false, tier: null, usd: 29, shortUsd: 1 });
    expect(await gateAt(1, "31000000").gate.check(WALLET)).toMatchObject({ ok: true, tier: "rust", usd: 31, shortUsd: 0 });
  });

  it("assigns tiers by USD held", async () => {
    expect((await gateAt(1, "250000000").gate.check(WALLET)).tier).toBe("chrome");
    expect((await gateAt(1, "1000000000").gate.check(WALLET)).tier).toBe("gold");
    expect((await gateAt(0.5, "10000000000").gate.check(WALLET)).tier).toBe("diamond");
  });

  it("sums every token account of the owner, in raw units beyond 2^53", async () => {
    const f = rpcReturning([["9007199254740993", 9], ["7", 9]]);
    const g = new BalanceGate({ mint: MINT, balances: new RpcBalanceReader("http://rpc", f), prices: [new FixedPrice(0.01)], gateUsd: 30 });
    const r = await g.check(WALLET);
    expect(r.tokensRaw).toBe(9007199254741000n);
    expect(r.usd).toBeCloseTo(90071.99, 1);
  });

  it("uses the lowest price of its sources, skipping ones that fail or have none", async () => {
    const broken: PriceReader = { name: "curve", usdPrice: async () => { throw new Error("down"); } };
    const none: PriceReader = { name: "jupiter", usdPrice: async () => null };
    const { gate } = gateAt(2, "20000000", 6, [new FixedPrice(1.4), broken, none]);
    expect(await gate.check(WALLET)).toMatchObject({ usd: 28, ok: false });
  });

  it("caches a check for 60 s; the match-start re-check bypasses the cache", async () => {
    const t = gateAt(1, "31000000");
    await t.gate.check(WALLET);
    expect((await t.gate.check(WALLET)).cached).toBe(true);
    expect(t.calls()).toBe(1);
    await t.gate.check(WALLET, { bypassCache: true });
    expect(t.calls()).toBe(2);
    t.advance(60_001);
    expect((await t.gate.check(WALLET)).cached).toBe(false);
    expect(t.calls()).toBe(3);
  });

  it("doesn't cache a failed check (a player who just bought can retry at once)", async () => {
    const t = gateAt(1, "10000000");
    await t.gate.check(WALLET);
    expect((await t.gate.check(WALLET)).cached).toBe(false);
    expect(t.calls()).toBe(2);
  });

  it("fails when no source has a price", async () => {
    const g = new BalanceGate({ mint: MINT, balances: new RpcBalanceReader("http://rpc", rpcReturning([])), prices: [{ name: "jupiter", usdPrice: async () => null }], gateUsd: 30 });
    await expect(g.check(WALLET)).rejects.toThrow(/no price/);
  });

  it("a wallet with no token accounts holds $0", async () => {
    const g = new BalanceGate({ mint: MINT, balances: new RpcBalanceReader("http://rpc", rpcReturning([])), prices: [new FixedPrice(1)], gateUsd: 30 });
    expect(await g.check(WALLET)).toMatchObject({ ok: false, usd: 0, tokensRaw: 0n, shortUsd: 30 });
  });
});

describe("JupiterPrice", () => {
  it("reads v3's usdPrice (and v2's nested string price) and sends the API key", async () => {
    let seen: Headers | null = null;
    const v3 = new JupiterPrice("https://api.jup.ag/price/v3", "k", (async (_u: unknown, init?: RequestInit) => {
      seen = new Headers(init?.headers);
      return new Response(JSON.stringify({ [MINT]: { usdPrice: 0.000321, decimals: 6 } }));
    }) as typeof fetch);
    expect(await v3.usdPrice(MINT)).toBe(0.000321);
    expect(seen!.get("x-api-key")).toBe("k");
    const v2 = new JupiterPrice("x", undefined, (async () => new Response(JSON.stringify({ data: { [MINT]: { price: "1.5" } } }))) as typeof fetch);
    expect(await v2.usdPrice(MINT)).toBe(1.5);
    const missing = new JupiterPrice("x", undefined, (async () => new Response(JSON.stringify({}))) as typeof fetch);
    expect(await missing.usdPrice(MINT)).toBeNull();
  });
});

describe("holdingUsd", () => {
  it("prices tiny memecoin prices without rounding them to zero", () => {
    expect(holdingUsd({ raw: 100_000_000_000_000n, decimals: 6 }, 0.0000003)).toBeCloseTo(30, 6);
  });
});
