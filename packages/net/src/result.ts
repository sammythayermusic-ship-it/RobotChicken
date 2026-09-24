/**
 * Match results: how a finished (or forfeited) sim maps onto the database's
 * `matches` row, the replay log format stored in `input_log`, the result
 * hash, and ELO. Shared by the game server (writes) and the web app (reads).
 */
import { Phase, Reason, type MatchState, type Replay } from "@cockfight/sim";

export type MatchReason = "ko" | "ringout" | "timeout" | "sudden_death" | "decision" | "forfeit" | "draw";
export type RoundReason = "ko" | "ringout" | "timeout" | "sudden_death" | "double_ko" | "sd_expired" | "forfeit";

export interface RoundRecord {
  /** 1-based round number. */
  n: number;
  /** 0 = P1, 1 = P2, 2 = drawn round. */
  winner: 0 | 1 | 2;
  reason: RoundReason;
  /** Sim tick the round ended on. */
  tick: number;
}

export interface MatchOutcome {
  /** null = draw (or abandoned, which is never recorded). */
  winner: 0 | 1 | null;
  reason: MatchReason;
}

const ROUND_REASON: Record<number, RoundReason | undefined> = {
  [Reason.ko]: "ko",
  [Reason.ringout]: "ringout",
  [Reason.timeout]: "timeout",
  [Reason.suddenDeath]: "sudden_death",
  [Reason.doubleKo]: "double_ko",
  [Reason.sdExpired]: "sd_expired",
};

/**
 * The round that ended between two consecutive states, if one did. A round
 * ends on the tick the sim leaves `fighting` with a round winner.
 */
export function roundEnded(prev: MatchState, next: MatchState): RoundRecord | null {
  if (prev.phase !== Phase.fighting || next.phase === Phase.fighting || next.roundWinner < 0) return null;
  return {
    n: next.round,
    winner: next.roundWinner as 0 | 1 | 2,
    reason: ROUND_REASON[next.reason] ?? "timeout",
    tick: next.tick,
  };
}

/**
 * The match outcome, following the mapping in supabase/README.md:
 * a forfeit wins by 'forfeit'; matchWinner 2 is a 'draw'; otherwise the
 * winner's reason is the final round's reason if they won it, else
 * 'decision' (won on rounds at the round cap after a drawn final round).
 */
export function outcome(s: MatchState, rounds: readonly RoundRecord[], forfeitWinner?: 0 | 1): MatchOutcome {
  if (forfeitWinner !== undefined) return { winner: forfeitWinner, reason: "forfeit" };
  if (s.matchWinner === 2) return { winner: null, reason: "draw" };
  if (s.matchWinner !== 0 && s.matchWinner !== 1) throw new Error("outcome: the match has not ended");
  const w = s.matchWinner;
  const last = rounds[rounds.length - 1];
  if (last && last.winner === w && (last.reason === "ko" || last.reason === "ringout" || last.reason === "timeout" || last.reason === "sudden_death")) {
    return { winner: w, reason: last.reason };
  }
  return { winner: w, reason: "decision" };
}

/** A forfeit records the round it ended in (the database needs at least one round). */
export function forfeitRound(s: MatchState, winner: 0 | 1): RoundRecord {
  return { n: s.round, winner, reason: "forfeit", tick: s.tick };
}

// Replay log ---------------------------------------------------------------

/** `input_log` is the replay JSON as UTF-8 (two arrays of {t, b}; a few KB). */
export function encodeReplayLog(r: Replay): string {
  return JSON.stringify({ v: r.v, rulesHash: r.rulesHash, matchId: r.matchId, ticks: r.ticks, p1: r.p1 ?? [], p2: r.p2 ?? [], finalHash: r.finalHash });
}

export function decodeReplayLog(json: string): Replay {
  const r = JSON.parse(json) as Replay;
  if (!r || r.v !== 1 || typeof r.matchId !== "string") throw new Error("not a replay log");
  return r;
}

/** Postgres returns bytea through PostgREST as "\x<hex>". */
export function byteaHexToString(hex: string): string {
  const h = hex.startsWith("\\x") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0 || /[^0-9a-f]/i.test(h)) throw new Error("not a bytea hex string");
  const bytes = new Uint8Array(h.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return new TextDecoder().decode(bytes);
}

/**
 * result_hash = sha256(matchId + winner + inputLog) as hex (spec). `winner`
 * is the winner's address, or the empty string for a draw.
 */
export async function resultHash(matchId: string, winner: string | null, inputLog: string): Promise<string> {
  const data = new TextEncoder().encode(`${matchId}${winner ?? ""}${inputLog}`);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// ELO ------------------------------------------------------------------------

export const ELO_K = 32;
export const ELO_START = 1000;

/**
 * New ratings after a match. `score` is P1's result: 1 win, 0 loss, 0.5 draw.
 * Rounded half up (floor(x + 0.5), the same in SQL); P2's change is the negative of P1's, so the pool is
 * conserved. Mirrored by record_match() in SQL (a test keeps them equal).
 */
export function eloUpdate(r1: number, r2: number, score: 0 | 0.5 | 1, k: number = ELO_K): [number, number] {
  const expected = 1 / (1 + Math.pow(10, (r2 - r1) / 400));
  const d = Math.floor(k * (score - expected) + 0.5);
  return [r1 + d, r2 - d];
}
