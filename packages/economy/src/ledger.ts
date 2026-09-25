/**
 * What the treasury needs from the database and the chain, as interfaces.
 * apps/worker implements them on Supabase and Solana; the simulator
 * (test/simulator.ts) implements them in memory, so one month of synthetic
 * play runs the same engine code the worker runs.
 */
import type { Price } from "./money";
import type { PayTier } from "./params";
import type { DailyReward, PoolState, RankedPlayer, SeedDraw } from "./pool";

export type PayoutKind = "win" | "daily";
export type PayoutStatus = "pending" | "sent" | "paid" | "deferred" | "failed" | "voided";

export interface PayoutRow {
  id: string;
  kind: PayoutKind;
  /** `win:<matchId>` or `daily:<YYYY-MM-DD>:<rank>`. */
  idemKey: string;
  to: string;
  amount: bigint;
  status: PayoutStatus;
  sig: string | null;
  attempts: number;
  createdAt: number;
}

export interface ClaimRecord {
  at: number;
  /** Where the fees were: the bonding curve or the AMM after graduation. */
  stage: "curve" | "amm";
  /** Gross creator fees this claim distributed (raw), and the parts. */
  gross: bigint;
  playerShare: bigint;
  projectShare: bigint;
  sig: string;
  priceUsd: number;
}

/** Ledger figures for the trailing windows, all raw base units. */
export interface LedgerWindow {
  gross24h: bigint;
  grossToday: bigint;
  playerShare24h: bigint;
  weighted24hMilli: bigint;
  /** Claimed player share + seed draws − payouts sent − sweeps, all time (see BudgetView). */
  allowance: bigint;
  /** Wins sent in the trailing hour (the midnight top-10 batch is exempt from the hourly cap). */
  sentLastHour: bigint;
  sentToday: bigint;
  /** Booked but not yet sent (pending + deferred): the hot wallet must keep covering these. */
  outstanding: bigint;
  seedToday: SeedDraw;
}

export interface SeedBalance {
  original: bigint;
  remaining: bigint;
}

export interface PauseState {
  paused: boolean;
  reason: string | null;
}

export interface WinBooking {
  matchId: string;
  endedAt: number;
  winner: string;
  loser: string;
  tier: PayTier;
  qualityBps: number;
}

export interface Ledger {
  window(now: number): Promise<LedgerWindow>;
  writePoolState(state: PoolState, now: number): Promise<void>;
  recordClaim(c: ClaimRecord): Promise<void>;
  recordSweep(amount: bigint, sig: string, at: number): Promise<void>;
  /** Rows to try now: pending, or deferred and due. Oldest first. */
  duePayouts(now: number, limit: number): Promise<PayoutRow[]>;
  /** Rows already sent whose confirmation is still open. */
  sentPayouts(): Promise<PayoutRow[]>;
  markSent(id: string, sig: string, at: number): Promise<void>;
  markPaid(id: string, at: number): Promise<void>;
  markDeferred(id: string, reason: string, nextAt: number): Promise<void>;
  /** Back to pending for another attempt (the previous transaction expired unconfirmed). */
  markRetry(id: string, reason: string): Promise<void>;
  markFailed(id: string, reason: string): Promise<void>;
  pause(): Promise<PauseState>;
  setPause(paused: boolean, reason: string | null): Promise<void>;
  hasDaily(day: string): Promise<boolean>;
  /** Wins on that UTC day per address (flagged wallets excluded), best first. */
  dailyRanking(day: string): Promise<RankedPlayer[]>;
  /** Gross claimed on that UTC day and the seed's daily part booked for it. */
  dailyPoolInputs(day: string): Promise<{ grossDay: bigint; seedDaily: bigint }>;
  bookDaily(day: string, pool: bigint, rewards: DailyReward[]): Promise<void>;
  seed(): Promise<SeedBalance>;
  hasSeedDraw(day: string): Promise<boolean>;
  bookSeedDraw(day: string, draw: SeedDraw, sig: string | null): Promise<void>;
  /**
   * Book a win at match end (the game server does this inside record_match;
   * the simulator does it here). Applies the per-wallet caps and returns the
   * amount booked (0 when capped or q = 0).
   */
  bookWin(w: WinBooking): Promise<bigint>;
}

/** A signed, not yet broadcast transfer: its signature is known before it is sent. */
export interface PreparedTransfer {
  sig: string;
  submit(): Promise<void>;
}

export type TxStatus = "confirmed" | "expired" | "failed" | "unknown";

export interface ClaimResult {
  stage: "curve" | "amm";
  /** What landed in the hot wallet's payout-token account. */
  received: bigint;
  sig: string;
}

export interface Chain {
  price(): Promise<Price>;
  hotBalance(): Promise<bigint>;
  /** Native balance for fees and rent (lamports). */
  hotSol(): Promise<bigint>;
  prepareTransfer(to: string, amount: bigint, memo: string): Promise<PreparedTransfer>;
  status(sig: string): Promise<TxStatus>;
  /** Claim creator fees into the hot wallet; null when nothing is claimable. */
  claim(): Promise<ClaimResult | null>;
  /** Seed wallet → hot wallet. */
  seedTransfer(amount: bigint): Promise<string>;
  /** Hot wallet → cold wallet, or null when no cold wallet is configured. */
  sweep(amount: bigint): Promise<string | null>;
}

export interface Alerts {
  alert(kind: "pause" | "low_sol" | "claim_failed" | "info", message: string): Promise<void>;
}
