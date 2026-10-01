/**
 * The gate's second price source: pump.fun's bonding-curve quote (spec: "the
 * lower of Jupiter and the bonding-curve quote").
 *
 * Spot price = virtual quote reserves / virtual token reserves, scaled by the
 * two mints' decimals, times the quote token's USD price ($COCK is paired to
 * PUMP, so the curve holds PUMP, priced through Jupiter). Once the curve is
 * complete (graduated to the AMM) its reserves are frozen and stale, so this
 * source answers null and Jupiter alone prices the coin.
 */
import type { PriceReader } from "./gate";
import { decodeBondingCurve, pumpPda } from "./tx";

export interface CurveChain {
  getAccountInfo(address: string): Promise<{ data: Uint8Array } | null>;
  getMint(mint: string): Promise<{ decimals: number }>;
}

export class CurvePrice implements PriceReader {
  readonly name = "curve" as const;
  private readonly chain: CurveChain;
  /** Prices the curve's quote mint (PUMP or wSOL) in USD. */
  private readonly quoteUsd: PriceReader;
  private readonly decimals = new Map<string, number>();

  constructor(chain: CurveChain, quoteUsd: PriceReader) {
    this.chain = chain;
    this.quoteUsd = quoteUsd;
  }

  async usdPrice(mint: string): Promise<number | null> {
    const acc = await this.chain.getAccountInfo(pumpPda.bondingCurve(mint));
    if (!acc) return null; // not a pump.fun coin
    const c = decodeBondingCurve(acc.data);
    if (c.complete || c.virtualTokenReserves === 0n) return null;
    const [tokenDec, quoteDec, quoteUsd] = await Promise.all([this.mintDecimals(mint), this.mintDecimals(c.quoteMint), this.quoteUsd.usdPrice(c.quoteMint)]);
    if (quoteUsd === null) return null;
    const quotePerToken = (Number(c.virtualQuoteReserves) / 10 ** quoteDec) / (Number(c.virtualTokenReserves) / 10 ** tokenDec);
    const usd = quotePerToken * quoteUsd;
    return Number.isFinite(usd) && usd > 0 ? usd : null;
  }

  private async mintDecimals(mint: string): Promise<number> {
    const hit = this.decimals.get(mint);
    if (hit !== undefined) return hit;
    const d = (await this.chain.getMint(mint)).decimals;
    this.decimals.set(mint, d);
    return d;
  }
}
