import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { BalanceGate, CurvePrice, FixedPrice, pumpPda, type CurveChain, type PriceReader } from "../src/index";

const MINT = "HFypaAkLk4XwKJvLK5hTvL65dhY2F61davhjo1x8pump";
const PUMP = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
const CREATOR = "Hqwjp8NAc9hyFxN1XUJoMQLotUdQuagwM2EpEMqCSjpF";

function curveBytes(o: { vToken: bigint; vQuote: bigint; complete?: boolean; quoteMint?: string }): Uint8Array {
  const b = new Uint8Array(8 + 5 * 8 + 1 + 32 + 2 + 32 + 8);
  const dv = new DataView(b.buffer);
  let off = 8;
  for (const v of [o.vToken, o.vQuote, 0n, 0n, 1_000_000_000_000_000n]) {
    dv.setBigUint64(off, v, true);
    off += 8;
  }
  b[off++] = o.complete ? 1 : 0;
  b.set(bs58.decode(CREATOR), off);
  off += 32 + 2;
  b.set(bs58.decode(o.quoteMint ?? PUMP), off);
  return b;
}

function chain(data: Uint8Array | null, decimals: Record<string, number> = {}): CurveChain & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    async getAccountInfo(a) {
      reads.push(a);
      return data ? { data } : null;
    },
    async getMint(m) {
      return { decimals: decimals[m] ?? 6 };
    },
  };
}

describe("CurvePrice (pump.fun bonding-curve quote)", () => {
  it("prices the token from the curve's virtual reserves and the quote token's USD price", async () => {
    // 1,000,000,000 tokens against 100,000 PUMP (both 6 decimals): 0.0001 PUMP per token; PUMP at $0.004.
    const c = chain(curveBytes({ vToken: 1_000_000_000_000_000n, vQuote: 100_000_000_000n }));
    const p = new CurvePrice(c, new FixedPrice(0.004));
    expect(await p.usdPrice(MINT)).toBeCloseTo(0.0000004, 12);
    expect(c.reads[0]).toBe(pumpPda.bondingCurve(MINT));
  });

  it("respects differing decimals (a SOL-paired curve: 9-decimal quote)", async () => {
    const SOL = "So11111111111111111111111111111111111111112";
    const c = chain(curveBytes({ vToken: 1_000_000_000_000_000n, vQuote: 30_000_000_000n, quoteMint: SOL }), { [SOL]: 9 });
    // 30 SOL / 1e9 tokens at $150 = $0.0000045
    expect(await new CurvePrice(c, new FixedPrice(150)).usdPrice(MINT)).toBeCloseTo(0.0000045, 12);
  });

  it("answers null once the curve has graduated, or when there is no curve", async () => {
    const done = chain(curveBytes({ vToken: 1n, vQuote: 1n, complete: true }));
    expect(await new CurvePrice(done, new FixedPrice(1)).usdPrice(MINT)).toBeNull();
    expect(await new CurvePrice(chain(null), new FixedPrice(1)).usdPrice(MINT)).toBeNull();
  });

  it("the gate takes the lower of Jupiter and the curve", async () => {
    const curve = new CurvePrice(chain(curveBytes({ vToken: 1_000_000_000_000_000n, vQuote: 100_000_000_000n })), new FixedPrice(0.004));
    const jupiter: PriceReader = { name: "jupiter", usdPrice: async () => 0.000001 };
    const balances = { holding: async () => ({ raw: 50_000_000n * 1_000_000n, decimals: 6 }) };
    const gate = new BalanceGate({ mint: MINT, balances, prices: [jupiter, curve], gateUsd: 30 });
    const r = await gate.check(CREATOR);
    // 50M tokens: $50 at Jupiter's price, $20 at the curve's: the curve (lower) decides.
    expect(r.source).toBe("curve");
    expect(r.usd).toBeCloseTo(20, 6);
    expect(r.ok).toBe(false);
  });
});
