/**
 * Chain layer. Phase 2 implements the balance gate (gate.ts); Phase 3 (fee
 * claims, swaps, payouts) implements the rest of these interfaces. Only
 * apps/worker will ever hold a private key.
 */
import bs58 from "bs58";
import { ed25519 } from "@noble/curves/ed25519.js";

export * from "./gate";
import type { Tier } from "@cockfight/shared";

export type { Tier };
export type Cluster = "devnet" | "mainnet-beta" | "localnet";

export const LAMPORTS_PER_SOL = 1_000_000_000n;

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
 * means "decodes to exactly 32 bytes". See isWalletAddress for payouts.
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

/**
 * True when the address is a point on the ed25519 curve: a key someone can
 * sign for. Program-derived addresses (token accounts, program state) are off
 * the curve; SOL sent to one could never be moved again, so the gate refuses
 * them. Same check as web3.js PublicKey.isOnCurve.
 */
export function isOnCurve(address: string): boolean {
  if (!isValidAddress(address)) return false;
  try {
    ed25519.Point.fromBytes(bs58.decode(address), true);
    return true;
  } catch {
    return false;
  }
}

/** A pasted wallet the game will accept: valid base58, 32 bytes, on the curve. */
export function isWalletAddress(s: string): boolean {
  return isOnCurve(s);
}
