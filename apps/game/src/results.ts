/**
 * Where finished matches go.
 *
 * - Ranked matches go to Supabase through record_match() (the match row and
 *   both ELO updates in one transaction) when SUPABASE_URL and the service key
 *   are set.
 * - Every match is also kept in memory (the last MEMORY_MATCHES), with an
 *   in-memory rating table for open playtest matches (which never touch the
 *   database) and for local dev without Supabase. The game server serves
 *   those at /api/matches/:id and /api/leaderboard, so replays and the
 *   leaderboard work with zero env vars.
 */
import { ELO_START, eloUpdate, type MatchReason, type RoundRecord } from "@cockfight/net";
import type { Tier } from "@cockfight/shared";
import type { PlayerInfo } from "./seats";

export interface MatchRecord {
  id: string;
  ranked: boolean;
  region: string;
  startedAt: Date;
  endedAt: Date;
  players: [PlayerInfo, PlayerInfo];
  winner: 0 | 1 | null;
  reason: MatchReason;
  rounds: RoundRecord[];
  /** Replay JSON (packages/net encodeReplayLog). */
  inputLog: string;
  resultHash: string;
  netQuality: [number, number];
}

/** A match as the public replay page reads it (the shape of match_replay_v, plus tiers). */
export interface PublicMatch {
  id: string;
  p1_name: string;
  p2_name: string;
  p1_tier: Tier;
  p2_tier: Tier;
  /** 0 / 1, or null for a draw. (match_replay_v has the winner's address instead.) */
  winner_side: 0 | 1 | null;
  reason: MatchReason;
  rounds: RoundRecord[];
  input_log: string;
  result_hash: string;
  started_at: string;
  ended_at: string;
  ranked: boolean;
}

export interface LeaderRow {
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
}

/** Ratings before and after, per side. */
export type EloChange = [[number, number], [number, number]];

export interface RatingStore {
  /** Current ratings of both players (for the HUD before the match). */
  ratings(players: [PlayerInfo, PlayerInfo]): Promise<[number, number]>;
  record(rec: MatchRecord): Promise<EloChange>;
}

export const MEMORY_MATCHES = 500;
const DAY_MS = 86_400_000;

interface MemPlayer {
  name: string;
  tier: Tier;
  elo: number;
  /** End times of this player's matches and whether they won (trimmed to 7 days for the windows). */
  results: { at: number; won: boolean }[];
  winsAll: number;
  matchesAll: number;
}

/** In-memory ratings, matches and leaderboard. */
export class MemoryStore implements RatingStore {
  private readonly players = new Map<string, MemPlayer>();
  private readonly matches = new Map<string, PublicMatch>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  async ratings(players: [PlayerInfo, PlayerInfo]): Promise<[number, number]> {
    return [this.players.get(players[0].id)?.elo ?? ELO_START, this.players.get(players[1].id)?.elo ?? ELO_START];
  }

  async record(rec: MatchRecord): Promise<EloChange> {
    this.remember(rec);
    if (this.matches.has(rec.id) && this.recorded.has(rec.id)) {
      const [a, b] = await this.ratings(rec.players);
      return [[a, a], [b, b]];
    }
    this.recorded.add(rec.id);
    const p = rec.players.map((pl) => this.player(pl)) as [MemPlayer, MemPlayer];
    const score = rec.winner === null ? 0.5 : rec.winner === 0 ? 1 : 0;
    const before: [number, number] = [p[0].elo, p[1].elo];
    const after = eloUpdate(before[0], before[1], score);
    const at = rec.endedAt.getTime();
    p.forEach((pl, i) => {
      pl.elo = after[i] as number;
      const won = rec.winner === i;
      pl.results.push({ at, won });
      pl.winsAll += won ? 1 : 0;
      pl.matchesAll += 1;
      const cutoff = this.now() - 7 * DAY_MS;
      while (pl.results.length > 0 && (pl.results[0] as { at: number }).at < cutoff) pl.results.shift();
    });
    return [[before[0], after[0]], [before[1], after[1]]];
  }

  private readonly recorded = new Set<string>();

  /** Keep the match for the replay page (also used for ranked matches stored in Supabase). */
  remember(rec: MatchRecord): void {
    if (this.matches.has(rec.id)) return;
    this.matches.set(rec.id, {
      id: rec.id,
      p1_name: rec.players[0].name,
      p2_name: rec.players[1].name,
      p1_tier: rec.players[0].tier,
      p2_tier: rec.players[1].tier,
      winner_side: rec.winner,
      reason: rec.reason,
      rounds: rec.rounds,
      input_log: rec.inputLog,
      result_hash: rec.resultHash,
      started_at: rec.startedAt.toISOString(),
      ended_at: rec.endedAt.toISOString(),
      ranked: rec.ranked,
    });
    while (this.matches.size > MEMORY_MATCHES) {
      const oldest = this.matches.keys().next().value as string;
      this.matches.delete(oldest);
      this.recorded.delete(oldest);
    }
  }

  getMatch(id: string): PublicMatch | null {
    return this.matches.get(id) ?? null;
  }

  leaderboard(limit = 100): LeaderRow[] {
    const now = this.now();
    const dayStart = Math.floor(now / DAY_MS) * DAY_MS;
    const weekStart = now - 7 * DAY_MS;
    const rows: LeaderRow[] = [];
    for (const [id, p] of this.players) {
      let wt = 0, mt = 0, w7 = 0, m7 = 0;
      for (const r of p.results) {
        if (r.at >= weekStart) {
          m7++;
          if (r.won) w7++;
        }
        if (r.at >= dayStart) {
          mt++;
          if (r.won) wt++;
        }
      }
      rows.push({ id, display_name: p.name, tier: p.tier, elo: p.elo, wins_today: wt, matches_today: mt, wins_7d: w7, matches_7d: m7, wins_all: p.winsAll, matches_all: p.matchesAll });
    }
    rows.sort((a, b) => b.wins_today - a.wins_today || b.elo - a.elo || b.wins_all - a.wins_all);
    return rows.slice(0, limit);
  }

  private player(pl: PlayerInfo): MemPlayer {
    let p = this.players.get(pl.id);
    if (!p) {
      p = { name: pl.name, tier: pl.tier, elo: ELO_START, results: [], winsAll: 0, matchesAll: 0 };
      this.players.set(pl.id, p);
    }
    p.name = pl.name;
    p.tier = pl.tier;
    return p;
  }
}

export interface SupabaseConfig {
  url: string;
  serviceKey: string;
  fetch?: typeof fetch;
}

/** Headers for the Data API. New secret keys (sb_secret_…) go in apikey only; legacy JWT keys also as a bearer token. */
export function supabaseHeaders(key: string): Record<string, string> {
  const h: Record<string, string> = { apikey: key, "content-type": "application/json" };
  if (key.startsWith("eyJ")) h.authorization = `Bearer ${key}`;
  return h;
}

/** Ranked results in Supabase (record_match), ratings read from players. */
export class SupabaseStore implements RatingStore {
  private readonly cfg: SupabaseConfig;
  constructor(cfg: SupabaseConfig) {
    this.cfg = cfg;
  }

  private get f(): typeof fetch {
    return this.cfg.fetch ?? fetch;
  }

  async ratings(players: [PlayerInfo, PlayerInfo]): Promise<[number, number]> {
    const ids = players.map((p) => p.address).filter((a): a is string => !!a);
    if (ids.length !== 2) return [ELO_START, ELO_START];
    const url = `${this.cfg.url}/rest/v1/players?select=address,elo&address=in.(${ids.join(",")})`;
    const res = await this.f(url, { headers: supabaseHeaders(this.cfg.serviceKey), signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`supabase players: HTTP ${res.status}`);
    const rows = (await res.json()) as { address: string; elo: number }[];
    const elo = (a: string) => rows.find((r) => r.address === a)?.elo ?? ELO_START;
    return [elo(ids[0] as string), elo(ids[1] as string)];
  }

  async record(rec: MatchRecord): Promise<EloChange> {
    const [a, b] = rec.players;
    if (!a.address || !b.address) throw new Error("record: ranked players need addresses");
    const body = {
      p_id: rec.id,
      p_region: rec.region,
      p_started_at: rec.startedAt.toISOString(),
      p_ended_at: rec.endedAt.toISOString(),
      p_p1: a.address,
      p_p2: b.address,
      p_tier1: a.tier,
      p_tier2: b.tier,
      p_winner: rec.winner === null ? null : rec.players[rec.winner].address,
      p_reason: rec.reason,
      p_rounds: rec.rounds,
      p_input_log: rec.inputLog,
      p_result_hash: rec.resultHash,
      p_net_quality_p1: rec.netQuality[0],
      p_net_quality_p2: rec.netQuality[1],
    };
    const res = await this.f(`${this.cfg.url}/rest/v1/rpc/record_match`, {
      method: "POST",
      headers: supabaseHeaders(this.cfg.serviceKey),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`supabase record_match: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    const rows = (await res.json()) as { address: string; elo_before: number; elo_after: number }[];
    const pick = (addr: string): [number, number] => {
      const r = rows.find((x) => x.address === addr);
      if (!r) throw new Error("record_match returned no row for a player");
      return [r.elo_before, r.elo_after];
    };
    return [pick(a.address), pick(b.address)];
  }

  /** record_gate(): the audit row and the player's tier. Returns the rating (null below the gate). */
  async recordGate(g: { address: string; usd: number; tokensRaw: bigint; decimals: number; source: string; tier: Tier | null }): Promise<number | null> {
    const res = await this.f(`${this.cfg.url}/rest/v1/rpc/record_gate`, {
      method: "POST",
      headers: supabaseHeaders(this.cfg.serviceKey),
      body: JSON.stringify({
        p_address: g.address,
        p_usd: Math.round(g.usd * 10_000) / 10_000,
        p_tokens: g.tokensRaw.toString(),
        p_decimals: g.decimals,
        p_source: g.source,
        p_tier: g.tier,
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`supabase record_gate: HTTP ${res.status}`);
    return (await res.json()) as number | null;
  }
}

/** Retry a store call a few times (transient network / 5xx), then give up. */
export async function withRetry<T>(fn: () => Promise<T>, tries = 3, delayMs = 500): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, delayMs * 2 ** i));
    }
  }
  throw last;
}
