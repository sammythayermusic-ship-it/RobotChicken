/**
 * Who sits in a fight room. The queue fills these from the gate (address,
 * tier) or, in open mode, from the name a player typed.
 */
import { randomBytes } from "node:crypto";
import type { Tier } from "@cockfight/shared";

export interface PlayerInfo {
  /** Stable id for pairing and results: the wallet address, or "guest:<random>" in open mode. */
  id: string;
  /** Wallet address (ranked only). */
  address: string | null;
  name: string;
  tier: Tier;
}

export interface FightOptions {
  /** Proves the room was created by this process's queue, not by a client. */
  key: string;
  matchId: string;
  ranked: boolean;
  players: [PlayerInfo, PlayerInfo];
}

/** Seat auth data handed to reserveSeatFor. */
export interface SeatAuth {
  side: 0 | 1;
  player: PlayerInfo;
}

/**
 * A per-process secret the queue passes when it creates a fight room. Clients
 * can pass any create options, so without it a client could seat itself.
 */
export const ROOM_KEY = randomBytes(24).toString("base64url");

/** Names shown in the HUD: 1-16 chars of letters, digits, space, _ and -. */
export function cleanName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (s.length < 1 || s.length > 16 || !/^[A-Za-z0-9 _-]+$/.test(s)) return null;
  return s;
}
