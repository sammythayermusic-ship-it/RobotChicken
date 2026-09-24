/**
 * Phase 2 database functions: record_gate (gate audit + player tier) and
 * record_match (match row + both ELO updates in one transaction).
 */
import type { PGlite, PGliteInterface } from "@electric-sql/pglite";
import { byteaHexToString, eloUpdate } from "@cockfight/net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GRANT_MODES, as, freshDb } from "../src/db/harness";

const ROOSTER = "So11111111111111111111111111111111111111112";
const HEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const HASH = "ab".repeat(32);

type Row = Record<string, unknown>;

async function rows<T = Row>(db: PGliteInterface, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

interface Rec {
  id: string;
  p1?: string;
  p2?: string;
  winner?: string | null;
  reason?: string;
  log?: string;
}

async function recordMatch(db: PGliteInterface, r: Rec) {
  return rows<{ address: string; elo_before: number; elo_after: number }>(
    db,
    `select * from public.record_match($1, 'iad', now() - interval '2 minutes', now(), $2, $3, 'rust', 'gold', $4, $5,
       '[{"n":1,"winner":0,"reason":"ko","tick":900}]'::jsonb, $6, $7, 1.0, 0.97)`,
    [r.id, r.p1 ?? ROOSTER, r.p2 ?? HEN, r.winner === undefined ? (r.p1 ?? ROOSTER) : r.winner, r.reason ?? "ko", r.log ?? '{"v":1}', HASH],
  );
}

describe.each(GRANT_MODES)("Phase 2 functions on a %s-grants project", (mode) => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb(mode);
  }, 60_000);
  afterAll(() => db?.close());

  async function scratch<T>(fn: (c: PGliteInterface) => Promise<T>): Promise<T> {
    const c = await db.clone();
    try {
      return await as(c, "service_role", () => fn(c));
    } finally {
      await c.close();
    }
  }

  it("record_gate writes the audit row and the player's tier, and returns the rating", async () => {
    await scratch(async (c) => {
      const [first] = await rows<{ elo: number | null }>(c, "select public.record_gate($1, 31.5, 1234567, 6::smallint, 'fixed', 'rust') as elo", [ROOSTER]);
      expect(first?.elo).toBe(1000);
      const below = await rows<{ elo: number | null }>(c, "select public.record_gate($1, 29, 10, 6::smallint, 'jupiter', null) as elo", [HEN]);
      expect(below[0]?.elo).toBeNull();
      expect(await rows(c, "select address, tier from public.players order by address")).toEqual([{ address: ROOSTER, tier: "rust" }]);
      expect((await rows(c, "select source from public.balance_checks order by checked_at, source")).map((r) => r.source).sort()).toEqual(["fixed", "jupiter"]);
      await c.query("select public.record_gate($1, 300, 1, 6::smallint, 'jupiter', 'chrome')", [ROOSTER]);
      expect(await rows(c, "select tier from public.players where address = $1", [ROOSTER])).toEqual([{ tier: "chrome" }]);
      await expect(c.query("select public.record_gate($1, 1, 1, 6::smallint, 'guess', null)", [ROOSTER])).rejects.toThrow();
    });
  });

  it("record_match stores the match and moves both ratings by the same ELO as packages/net", async () => {
    await scratch(async (c) => {
      const id = "11111111-1111-4111-8111-111111111111";
      const out = await recordMatch(c, { id, log: '{"v":1,"matchId":"m"}' });
      const [p1, p2] = eloUpdate(1000, 1000, 1);
      expect(out).toEqual([
        { address: ROOSTER, elo_before: 1000, elo_after: p1 },
        { address: HEN, elo_before: 1000, elo_after: p2 },
      ]);
      const [m] = await rows<{ winner: string; reason: string; input_log: Uint8Array }>(c, "select winner, reason, input_log from public.matches where id = $1", [id]);
      expect(m?.winner).toBe(ROOSTER);
      expect(new TextDecoder().decode(m?.input_log)).toBe('{"v":1,"matchId":"m"}');
      // PostgREST hands bytea over as \x-hex; the web decodes it back.
      const [hex] = await rows<{ h: string }>(c, "select input_log::text as h from public.matches where id = $1", [id]);
      expect(byteaHexToString(hex?.h ?? "")).toBe('{"v":1,"matchId":"m"}');

      // Uneven ratings, a loss for P1, then a draw: the SQL and JS formulas agree.
      let r = [p1, p2] as [number, number];
      const cases: [string, string | null, 0 | 0.5 | 1][] = [
        ["22222222-2222-4222-8222-222222222222", HEN, 0],
        ["33333333-3333-4333-8333-333333333333", null, 0.5],
        ["44444444-4444-4444-8444-444444444444", ROOSTER, 1],
      ];
      for (const [mid, winner, score] of cases) {
        const got = await recordMatch(c, { id: mid, winner, reason: winner ? "ko" : "draw" });
        const want = eloUpdate(r[0], r[1], score);
        expect(got.map((x) => x.elo_after)).toEqual(want);
        r = want;
      }
    });
  });

  it("record_match is idempotent on the match id", async () => {
    await scratch(async (c) => {
      const id = "55555555-5555-4555-8555-555555555555";
      const first = await recordMatch(c, { id });
      const again = await recordMatch(c, { id });
      expect(again.map((x) => [x.elo_before, x.elo_after])).toEqual(first.map((x) => [x.elo_after, x.elo_after]));
      expect(await rows(c, "select count(*)::int as n from public.matches")).toEqual([{ n: 1 }]);
    });
  });

  it("record_match rejects an inconsistent result and changes nothing", async () => {
    await scratch(async (c) => {
      await expect(recordMatch(c, { id: "66666666-6666-4666-8666-666666666666", winner: null, reason: "ko" })).rejects.toThrow();
      expect(await rows(c, "select count(*)::int as n from public.matches")).toEqual([{ n: 0 }]);
    });
  });

  it("neither function is callable with the web keys", async () => {
    const c = await db.clone();
    try {
      for (const role of ["anon", "authenticated"] as const) {
        await expect(as(c, role, () => c.query("select public.record_gate($1, 31, 1, 6::smallint, 'fixed', 'rust')", [ROOSTER]))).rejects.toMatchObject({ code: "42501" });
      }
    } finally {
      await c.close();
    }
  });
});
