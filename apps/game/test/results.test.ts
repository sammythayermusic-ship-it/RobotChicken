import { describe, expect, it } from "vitest";
import { MemoryStore, MEMORY_MATCHES, supabaseHeaders, type MatchRecord } from "../src/results";
import type { PlayerInfo } from "../src/seats";

const A: PlayerInfo = { id: "guest:a", address: null, name: "Ace", tier: "rust", ipHash: null, fp: null };
const B: PlayerInfo = { id: "guest:b", address: null, name: "Bee", tier: "gold", ipHash: null, fp: null };

function rec(id: string, winner: 0 | 1 | null, endedAt: number, players: [PlayerInfo, PlayerInfo] = [A, B]): MatchRecord {
  return {
    id,
    ranked: false,
    region: "local",
    startedAt: new Date(endedAt - 60_000),
    endedAt: new Date(endedAt),
    players,
    winner,
    reason: winner === null ? "draw" : "ko",
    rounds: [],
    inputLog: "{}",
    resultHash: "0".repeat(64),
    netQuality: [1, 1],
    tierPaid: null,
    qualityBps: null,
    flag: null,
  };
}

describe("MemoryStore", () => {
  it("rates matches with ELO, counts draws as a match for both, and is idempotent on the id", async () => {
    const now = Date.UTC(2026, 8, 24, 12);
    const m = new MemoryStore(() => now);
    expect(await m.record(rec("m1", 0, now))).toEqual({ elo: [[1000, 1016], [1000, 984]], payout: null });
    expect(await m.record(rec("m1", 0, now))).toEqual({ elo: [[1016, 1016], [984, 984]], payout: null });
    await m.record(rec("m2", null, now));
    const lb = m.leaderboard();
    expect(lb[0]).toMatchObject({ display_name: "Ace", wins_today: 1, matches_today: 2, wins_all: 1, matches_all: 2 });
    expect(lb[1]).toMatchObject({ display_name: "Bee", wins_today: 0, matches_today: 2 });
    expect(await m.ratings([A, B])).toEqual([lb[0]!.elo, lb[1]!.elo]);
  });

  it("windows: today (UTC), 7 days, all time", async () => {
    const now = Date.UTC(2026, 8, 24, 12);
    const m = new MemoryStore(() => now);
    await m.record(rec("old", 0, now - 3 * 86_400_000));
    await m.record(rec("yday", 0, Date.UTC(2026, 8, 23, 23, 59)));
    await m.record(rec("today", 1, now));
    const ace = m.leaderboard().find((r) => r.display_name === "Ace")!;
    expect(ace).toMatchObject({ wins_today: 0, matches_today: 1, wins_7d: 2, matches_7d: 3, wins_all: 2, matches_all: 3 });
  });

  it("keeps the last MEMORY_MATCHES matches for replays", async () => {
    const m = new MemoryStore();
    for (let i = 0; i <= MEMORY_MATCHES; i++) m.remember(rec(`m${i}`, 0, Date.now()));
    expect(m.getMatch("m0")).toBeNull();
    expect(m.getMatch(`m${MEMORY_MATCHES}`)).toMatchObject({ p1_name: "Ace", p2_tier: "gold", winner_side: 0 });
  });
});

describe("supabaseHeaders", () => {
  it("sends new secret keys as apikey only and legacy JWT keys as a bearer too", () => {
    expect(supabaseHeaders("sb_secret_x")).toEqual({ apikey: "sb_secret_x", "content-type": "application/json" });
    expect(supabaseHeaders("eyJhbGc.x.y").authorization).toBe("Bearer eyJhbGc.x.y");
  });
});
