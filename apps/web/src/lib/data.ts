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

// Phase 3: the live pool, payouts and profiles (Supabase public views only:
// without Supabase the site shows that payouts aren't live).

/** The live pool as pool_v serves it; amounts are raw units of the payout token (strings: they exceed 2^53). */
export interface PoolView {
  computedAt: string | null;
  priceUsd: number;
  decimals: number;
  /** What the next win pays per tier (raw). */
  win: { rust: string; chrome: string; gold: string };
  /** Floor and cap per tier at this price (raw). */
  min: { rust: string; chrome: string; gold: string } | null;
  max: { rust: string; chrome: string; gold: string } | null;
  perWinBudget: string;
  dailyPool: string;
  gross24h: string;
  grossToday: string;
  grossAll: string;
  playerShareAll: string;
  claimsAll: number;
  lastClaimAt: string | null;
  paidAll: string;
  paidUsdAll: number;
  paidCountAll: number;
  paid24h: string;
  paidCount24h: number;
  seedOriginal: string;
  seedRemaining: string;
  /** The prize pot (raw), before the reserve. */
  pot: string;
  paused: boolean;
  /** The server's clock, for the countdown. */
  now: string;
}

export interface PayoutRowView {
  id: string;
  kind: "win" | "daily";
  matchId: string | null;
  day: string | null;
  rank: number | null;
  address: string;
  name: string;
  amount: string;
  usd: number;
  status: string;
  sig: string | null;
  createdAt: string;
  paidAt: string | null;
}

export interface DailyRewardView {
  day: string;
  rank: number;
  address: string;
  name: string;
  wins: number;
  pool: string;
  shareBps: number;
  amount: string;
  sig: string | null;
  status: string | null;
}

/** Null when Supabase isn't configured or the worker hasn't written a pool yet. */
export async function fetchPool(): Promise<PoolView | null> {
  const sb = supabase();
  if (!sb) return null;
  const res = await fetch(`${sb.url}/rest/v1/pool_v?select=*`, { headers: sbHeaders(sb.key), cache: "no-store" });
  if (!res.ok) throw new Error(`pool: HTTP ${res.status}`);
  const [r] = (await res.json()) as Record<string, unknown>[];
  if (!r || r.computed_at === null) return null;
  const str = (k: string) => String(r[k] ?? "0");
  const detail = (r.detail ?? {}) as { min?: Record<string, string>; max?: Record<string, string>; pot?: string };
  const tiers = (d: Record<string, string> | undefined) => (d ? { rust: String(d.rust ?? "0"), chrome: String(d.chrome ?? "0"), gold: String(d.gold ?? "0") } : null);
  return {
    computedAt: r.computed_at as string,
    priceUsd: Number(r.price_usd),
    decimals: Number(r.decimals),
    win: { rust: str("win_rust"), chrome: str("win_chrome"), gold: str("win_gold") },
    min: tiers(detail.min),
    max: tiers(detail.max),
    perWinBudget: str("per_win_budget"),
    dailyPool: str("daily_pool"),
    gross24h: str("gross_24h"),
    grossToday: str("gross_today"),
    grossAll: str("gross_all"),
    playerShareAll: str("player_share_all"),
    claimsAll: Number(r.claims_all ?? 0),
    lastClaimAt: (r.last_claim_at as string | null) ?? null,
    paidAll: str("paid_all"),
    paidUsdAll: Number(r.paid_usd_all ?? 0),
    paidCountAll: Number(r.paid_count_all ?? 0),
    paid24h: str("paid_24h"),
    paidCount24h: Number(r.paid_count_24h ?? 0),
    seedOriginal: str("seed_original"),
    seedRemaining: str("seed_remaining"),
    pot: typeof detail.pot === "string" && /^\d+$/.test(detail.pot) ? detail.pot : "0",
    paused: !!r.paused,
    now: String(r.now ?? new Date().toISOString()),
  };
}

interface PayoutRecord {
  id: string;
  kind: "win" | "daily";
  match_id: string | null;
  day: string | null;
  rank: number | null;
  to_address: string;
  display_name: string;
  amount: string;
  usd: string | number;
  status: string;
  tx_sig: string | null;
  created_at: string;
  paid_at: string | null;
}

const toPayout = (p: PayoutRecord): PayoutRowView => ({
  id: p.id,
  kind: p.kind,
  matchId: p.match_id,
  day: p.day,
  rank: p.rank,
  address: p.to_address,
  name: p.display_name,
  amount: String(p.amount),
  usd: Number(p.usd),
  status: p.status,
  sig: p.tx_sig,
  createdAt: p.created_at,
  paidAt: p.paid_at,
});

/** Recent payouts (newest first), optionally one wallet's. Empty without Supabase. */
export async function fetchPayouts(o: { limit?: number; address?: string; matchId?: string } = {}): Promise<PayoutRowView[]> {
  const sb = supabase();
  if (!sb) return [];
  const filter = o.address ? `&to_address=eq.${o.address}` : o.matchId ? `&match_id=eq.${o.matchId}` : "";
  const res = await fetch(`${sb.url}/rest/v1/payouts_v?select=*&order=created_at.desc&limit=${o.limit ?? 10}${filter}`, { headers: sbHeaders(sb.key), cache: "no-store" });
  if (!res.ok) throw new Error(`payouts: HTTP ${res.status}`);
  return ((await res.json()) as PayoutRecord[]).map(toPayout);
}

/** A closed day's top 10 and what they were paid (the latest day when none is given). */
export async function fetchDailyRewards(day?: string): Promise<DailyRewardView[]> {
  const sb = supabase();
  if (!sb) return [];
  const filter = day ? `&day=eq.${day}` : "";
  const res = await fetch(`${sb.url}/rest/v1/daily_rewards_v?select=*&order=day.desc,rank.asc&limit=10${filter}`, { headers: sbHeaders(sb.key), cache: "no-store" });
  if (!res.ok) throw new Error(`daily rewards: HTTP ${res.status}`);
  const rows = (await res.json()) as { day: string; rank: number; address: string; display_name: string; wins: number; pool: string; share_bps: number; amount: string; tx_sig: string | null; status: string | null }[];
  const latest = rows[0]?.day;
  return rows
    .filter((r) => r.day === latest)
    .map((r) => ({ day: r.day, rank: r.rank, address: r.address, name: r.display_name, wins: r.wins, pool: String(r.pool), shareBps: r.share_bps, amount: String(r.amount), sig: r.tx_sig, status: r.status }));
}

export interface ProfileView {
  address: string;
  name: string;
  tier: Tier | null;
  elo: number | null;
  winsToday: number;
  matchesToday: number;
  wins7d: number;
  matches7d: number;
  winsAll: number;
  matchesAll: number;
  earnedToday: string;
  earnedAll: string;
  earnedUsdToday: number;
  earnedUsdAll: number;
  /** Rank on today's board (1-based), null when not on it. */
  rankToday: number | null;
}

/** One wallet's standing (leaderboard_v) and its rank today. Null when the wallet has never played ranked. */
export async function fetchProfile(address: string): Promise<ProfileView | null> {
  const sb = supabase();
  if (!sb) return null;
  const res = await fetch(`${sb.url}/rest/v1/leaderboard_v?select=*&address=eq.${address}`, { headers: sbHeaders(sb.key), cache: "no-store" });
  if (!res.ok) throw new Error(`profile: HTTP ${res.status}`);
  const [r] = (await res.json()) as Record<string, unknown>[];
  if (!r) return null;
  let rankToday: number | null = null;
  if (Number(r.wins_today) > 0) {
    const above = await fetch(
      `${sb.url}/rest/v1/leaderboard_v?select=address&or=(wins_today.gt.${Number(r.wins_today)},and(wins_today.eq.${Number(r.wins_today)},elo.gt.${Number(r.elo ?? 0)}))`,
      { headers: { ...sbHeaders(sb.key), prefer: "count=exact", "range-unit": "items", range: "0-0" }, cache: "no-store" },
    );
    const total = above.headers.get("content-range")?.split("/")[1];
    rankToday = total !== undefined && total !== "*" ? Number(total) + 1 : null;
  }
  return {
    address,
    name: String(r.display_name),
    tier: (r.tier as Tier | null) ?? null,
    elo: r.elo === null ? null : Number(r.elo),
    winsToday: Number(r.wins_today),
    matchesToday: Number(r.matches_today),
    wins7d: Number(r.wins_7d),
    matches7d: Number(r.matches_7d),
    winsAll: Number(r.wins_all),
    matchesAll: Number(r.matches_all),
    earnedToday: String(r.earned_today ?? "0"),
    earnedAll: String(r.earned_all ?? "0"),
    earnedUsdToday: Number(r.earned_usd_today ?? 0),
    earnedUsdAll: Number(r.earned_usd_all ?? 0),
    rankToday,
  };
}

/** Raw units → a whole-token string with thousands separators ("1,450 PUMP" style; up to 2 decimals). */
export function formatRaw(raw: string, decimals: number, symbol = "PUMP"): string {
  const digits = raw.replace(/^-/, "").padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals) || "0";
  const frac = decimals > 0 ? digits.slice(digits.length - decimals).slice(0, 2).replace(/0+$/, "") : "";
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${raw.startsWith("-") ? "-" : ""}${grouped}${frac ? `.${frac}` : ""} ${symbol}`.trim();
}

/** Raw units at a price → dollars. */
export function rawUsd(raw: string, decimals: number, priceUsd: number): number {
  return (Number(raw) / 10 ** decimals) * priceUsd;
}

export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd)) return "$0.00";
  if (usd >= 1000) return `$${Math.round(usd).toLocaleString("en-US")}`;
  return `$${usd.toFixed(2)}`;
}

export const DAILY_SPLIT_BPS = [2500, 1800, 1300, 1000, 800, 700, 600, 500, 400, 400] as const;

/** Solscan link for a transaction (mainnet). */
export const txUrl = (sig: string): string => `https://solscan.io/tx/${sig}`;
