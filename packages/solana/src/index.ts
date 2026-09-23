/**
 * Chain layer. Phase 0 ships the interfaces only; Phase 2 (balance gate) and
 * Phase 3 (fee claims, swaps, payouts) implement them. Only apps/worker will
 * ever hold a private key.
 */
import bs58 from "bs58";
import type { Tier } from "@cockfight/shared";

export type { Tier };
export type Cluster = "devnet" | "mainnet-beta" | "localnet";

export const LAMPORTS_PER_SOL = 1_000_000_000n;

export interface GateResult {
  ok: boolean;
  usd: number;
  tokens: number;
  tier: Tier | null;
  source: "jupiter" | "curve";
  checkedAt: string;
}

/** Reads a pasted wallet's $COCK balance and prices it (Phase 2). */
export interface BalanceGate {
  check(owner: string, opts?: { bypassCache?: boolean }): Promise<GateResult>;
}

export interface PriceSource {
  readonly name: "jupiter" | "curve";
  usdPrice(mint: string): Promise<number | null>;
}

/** Claims creator trading fees from the launch pool (Phase 3). */
export interface FeeClaimer {
  claimFees(opts: { dryRun: boolean }): Promise<{ stage: "dbc" | "damm"; quoteRaw: bigint; cockRaw: bigint; sig?: string }>;
}

export interface Swapper {
  toSol(opts: { mint: string; amountRaw: bigint; slippageBps: number; maxChunkUsd: number; dryRun: boolean }): Promise<{ lamports: bigint; sigs: string[] }>;
}

/** Idempotent payout sender (Phase 3). */
export interface PayoutSender {
  send(p: { to: string; lamports: bigint; idemKey: string }): Promise<{ sig: string }>;
}

/**
 * A Solana address is 32 bytes in base58. There is no checksum: validation
 * means "decodes to exactly 32 bytes". (Phase 2 should also reject off-curve
 * addresses, since SOL sent there can never be spent.)
 */
export function isValidAddress(s: string): boolean {
  if (typeof s !== "string" || s.length < 32 || s.length > 44) return false;
  try {
    return bs58.decode(s).length === 32;
  } catch {
    return false;
  }
}

/** "anon-XXXX" display name for an unclaimed address (last 4 chars). */
export function anonName(address: string): string {
  return `anon-${address.slice(-4)}`;
}
