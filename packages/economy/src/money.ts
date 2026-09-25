/**
 * Raw token amounts (bigint base units) and their dollar value.
 *
 * A double is fine for the dollar side (the site shows cents); the token side
 * is exact. Rounding is always toward zero, so a converted dollar amount can
 * never be a base unit more than asked.
 */

export interface Price {
  /** USD per whole token. */
  usd: number;
  /** The mint's decimals (PUMP: 6). */
  decimals: number;
}

export function bps(amount: bigint, basisPoints: number): bigint {
  return (amount * BigInt(Math.trunc(basisPoints))) / 10_000n;
}

export function pow10(decimals: number): bigint {
  return 10n ** BigInt(decimals);
}

/** Dollars → raw base units at `price`, truncated. 0 when the price is unknown (never a huge amount). */
export function usdToRaw(usd: number, price: Price): bigint {
  if (!(usd > 0) || !(price.usd > 0) || !Number.isFinite(price.usd)) return 0n;
  // Scale to integer micro-dollars first so a memecoin price like $0.0000031 keeps its digits.
  const microUsd = BigInt(Math.trunc(usd * 1e6));
  const microPrice = BigInt(Math.trunc(price.usd * 1e12)); // price in 1e-12 USD
  if (microPrice === 0n) return 0n;
  return (microUsd * 1_000_000n * pow10(price.decimals)) / microPrice;
}

/** Raw base units → dollars. */
export function rawToUsd(raw: bigint, price: Price): number {
  if (raw === 0n || !(price.usd > 0)) return 0;
  return (Number(raw) / Number(pow10(price.decimals))) * price.usd;
}

export function clampRaw(x: bigint, lo: bigint, hi: bigint): bigint {
  if (hi < lo) hi = lo;
  return x < lo ? lo : x > hi ? hi : x;
}

export function maxRaw(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

export function minRaw(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
