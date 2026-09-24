/**
 * Public data for the replay page and the leaderboard.
 *
 * Ranked matches live in Supabase: the browser reads the public views
 * (match_replay_v, leaderboard_v) with the publishable key. Replays not found
 * there (open playtest matches), and everything when Supabase isn't
 * configured, come from the game server's in-memory store
 * (/api/matches/:id, /api/leaderboard). The leaderboard shows Supabase's
 * ranked standings when it is configured, else the playtest standings.
 */
import { byteaHexToString, decodeReplayLog, type MatchReason, type RoundRecord } from "@cockfight/net";
import type { Replay } from "@cockfight/sim";
import type { Tier } from "@cockfight/shared";
import { publicEnv } from "@/env.public";
import { httpBase } from "@/game/net/api";

export interface MatchView {
  id: string;
  names: [string, string];
  tiers: [Tier, Tier];
  /** 0 / 1, null for a draw. */
  winnerSide: 0 | 1 | null;
  /** The winner's wallet (ranked), for the result hash. */
  winnerAddress: string | null;
  reason: MatchReason;
  rounds: RoundRecord[];
  replay: Replay;
  inputLog: string;
  resultHash: string;
  endedAt: string;
  ranked: boolean;
}

export interface LeaderRow {
  id: string;
  name: string;
  tier: Tier | null;
  elo: number | null;
  winsToday: number;
  matchesToday: number;
  wins7d: number;
  matches7d: number;
  winsAll: number;
  matchesAll: number;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function supabase(): { url: string; key: string } | null {
  const url = publicEnv.NEXT_PUBLIC_SUPABASE_URL;
  const key = publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return url && key ? { url, key } : null;
}

function sbHeaders(key: string): HeadersInit {
  // Publishable keys (sb_publishable_…) go in apikey only; legacy anon JWTs also as a bearer.
  return key.startsWith("eyJ") ? { apikey: key, authorization: `Bearer ${key}` } : { apikey: key };
}

interface ReplayRow {
  id: string;
  p1: string;
  p2: string;
  p1_name: string;
  p2_name: string;
  winner: string | null;
  reason: MatchReason;
  rounds: RoundRecord[];
  input_log: string;
  result_hash: string;
  ended_at: string;
}

interface MemoryMatch {
  id: string;
  p1_name: string;
  p2_name: string;
  p1_tier: Tier;
  p2_tier: Tier;
  winner_side: 0 | 1 | null;
  winner_address: string | null;
  reason: MatchReason;
  rounds: RoundRecord[];
  input_log: string;
  result_hash: string;
  ended_at: string;
  ranked: boolean;
}

export async function fetchMatch(id: string): Promise<MatchView | null> {
  if (!UUID.test(id)) return null;
  const sb = supabase();
  if (sb) {
    try {
      const res = await fetch(`${sb.url}/rest/v1/match_replay_v?id=eq.${id}&select=*`, { headers: sbHeaders(sb.key) });
      if (res.ok) {
        const rows = (await res.json()) as ReplayRow[];
        const r = rows[0];
        if (r) {
          const inputLog = byteaHexToString(r.input_log);
          return {
            id: r.id,
            names: [r.p1_name, r.p2_name],
            tiers: ["rust", "rust"],
            winnerSide: r.winner === null ? null : r.winner === r.p1 ? 0 : 1,
            winnerAddress: r.winner,
            reason: r.reason,
            rounds: r.rounds,
            replay: decodeReplayLog(inputLog),
            inputLog,
            resultHash: r.result_hash,
            endedAt: r.ended_at,
            ranked: true,
          };
        }
      }
    } catch {
      // fall through to the game server
    }
  }
  const res = await fetch(`${httpBase()}/api/matches/${id}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`match ${id}: HTTP ${res.status}`);
  const m = (await res.json()) as MemoryMatch;
  return {
    id: m.id,
    names: [m.p1_name, m.p2_name],
    tiers: [m.p1_tier, m.p2_tier],
    winnerSide: m.winner_side,
    // Open matches have no wallets: their hash covers the id and the log.
    winnerAddress: m.winner_address ?? null,
    reason: m.reason,
    rounds: m.rounds,
    replay: decodeReplayLog(m.input_log),
    inputLog: m.input_log,
    resultHash: m.result_hash,
    endedAt: m.ended_at,
    ranked: m.ranked,
  };
}

export type Board = "today" | "7d" | "all";

export async function fetchLeaderboard(board: Board): Promise<{ rows: LeaderRow[]; source: "supabase" | "server" }> {
  const sb = supabase();
  if (sb) {
    const order = board === "today" ? "wins_today.desc,elo.desc.nullslast" : board === "7d" ? "wins_7d.desc,elo.desc.nullslast" : "wins_all.desc,elo.desc.nullslast";
    const filter = board === "today" ? "&matches_today=gt.0" : board === "7d" ? "&matches_7d=gt.0" : "";
    const res = await fetch(`${sb.url}/rest/v1/leaderboard_v?select=*&order=${order}&limit=100${filter}`, { headers: sbHeaders(sb.key) });
    if (!res.ok) throw new Error(`leaderboard: HTTP ${res.status}`);
    const rows = (await res.json()) as {
      address: string;
      display_name: string;
      tier: Tier | null;
      elo: number | null;
      wins_today: number;
      matches_today: number;
      wins_7d: number;
      matches_7d: number;
      wins_all: number;
      matches_all: number;
    }[];
    return {
      source: "supabase",
      rows: rows.map((r) => ({
        id: r.address,
        name: r.display_name,
        tier: r.tier,
        elo: r.elo,
        winsToday: r.wins_today,
        matchesToday: r.matches_today,
        wins7d: r.wins_7d,
        matches7d: r.matches_7d,
        winsAll: r.wins_all,
        matchesAll: r.matches_all,
      })),
    };
  }
  const res = await fetch(`${httpBase()}/api/leaderboard`);
  if (!res.ok) throw new Error(`leaderboard: HTTP ${res.status}`);
  const body = (await res.json()) as {
    rows: {
      id: string;
      display_name: string;
      tier: Tier;
      elo: number;
      wins_today: number;
      matches_today: number;
      wins_7d: number;
      matches_7d: number;
      wins_all: number;
      matches_all: number;
    }[];
  };
  const rows = body.rows
    .filter((r) => (board === "today" ? r.matches_today > 0 : board === "7d" ? r.matches_7d > 0 : true))
    .map((r) => ({
      id: r.id,
      name: r.display_name,
      tier: r.tier,
      elo: r.elo,
      winsToday: r.wins_today,
      matchesToday: r.matches_today,
      wins7d: r.wins_7d,
      matches7d: r.matches_7d,
      winsAll: r.wins_all,
      matchesAll: r.matches_all,
    }));
  const key = board === "today" ? "winsToday" : board === "7d" ? "wins7d" : "winsAll";
  rows.sort((a, b) => b[key] - a[key] || (b.elo ?? 0) - (a.elo ?? 0));
  return { source: "server", rows };
}
