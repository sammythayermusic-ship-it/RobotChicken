/**
 * Phase 3 database functions: record_match books the win payout from
 * pool_state under the per-wallet caps; treasury_window, daily_ranking,
 * book_daily, book_seed_draw, seed_topup and claim_username serve the worker
 * and the game server.
 */
import type { PGlite, PGliteInterface } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GRANT_MODES, as, freshDb } from "../src/db/harness";

const ROOSTER = "So11111111111111111111111111111111111111112";
const HEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const CHICK = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const HASH = "ab".repeat(32);
const sig = (c: string): string => c.repeat(88);
const IP_A = "a".repeat(32);
const FP_A = "b".repeat(32);

type Row = Record<string, unknown>;

async function rows<T = Row>(db: PGliteInterface, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

interface Rec {
  id?: string;
  p1?: string;
  p2?: string;
  tier1?: string;
  tier2?: string;
  winner?: string | null;
  reason?: string;
  tierPaid?: string | null;
  q?: number | null;
  ip1?: string | null;
  ip2?: string | null;
  fp1?: string | null;
  fp2?: string | null;
  endedAgo?: string;
}

let seq = 0;
const uuid = () => `${String(++seq).padStart(8, "0")}-0000-4000-8000-000000000000`;

async function recordMatch(db: PGliteInterface, r: Rec) {
  return rows<{ address: string; elo_before: number; elo_after: number; payout: string; payout_reason: string }>(
    db,
    `select * from public.record_match($1, 'iad', now() - interval '2 minutes', now() - $14::interval, $2, $3, $4, $5, $6, $7,
       '[{"n":1,"winner":0,"reason":"ko","tick":900}]'::jsonb, '{"v":1}', $8, 1.0, 0.97, $9, $10::smallint, $11, $12, $13, $15)`,
    [
      r.id ?? uuid(), r.p1 ?? ROOSTER, r.p2 ?? HEN, r.tier1 ?? "rust", r.tier2 ?? "gold",
      r.winner === undefined ? (r.p1 ?? ROOSTER) : r.winner, r.reason ?? "ko", HASH,
      r.tierPaid === undefined ? "rust" : r.tierPaid, r.q === undefined ? 10000 : r.q,
      r.ip1 ?? null, r.ip2 ?? null, r.fp1 ?? null, r.endedAgo ?? "0 seconds", r.fp2 ?? null,
    ],
  );
}

async function setPool(db: PGliteInterface, rust = 580_000_000, chrome = 1_450_000_000, gold = 3_480_000_000): Promise<void> {
  await db.query(
    `insert into public.pool_state (price_usd, decimals, win_rust, win_chrome, win_gold, per_win_budget, weighted_milli, daily_pool, hot_target, gross_24h, gross_today, allowance, outstanding)
     values (0.005, 6, $1, $2, $3, 1500000000000, 2600000, 600000000000, 2850000000000, 3000000000000, 3000000000000, 2000000000000, 0)
     on conflict (id) do update set win_rust = excluded.win_rust, win_chrome = excluded.win_chrome, win_gold = excluded.win_gold, computed_at = now()`,
    [rust, chrome, gold],
  );
}

describe.each(GRANT_MODES)("Phase 3 functions on a %s-grants project", (mode) => {
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

  it("record_match books the win from pool_state at the paid tier, times the quality multiplier, in the same transaction", async () => {
    await scratch(async (c) => {
      await setPool(c);
      const id = uuid();
      const out = await recordMatch(c, { id, tierPaid: "chrome" });
      expect(out.map((x) => [x.address, x.payout, x.payout_reason])).toEqual([[ROOSTER, "1450000000", "paid"], [HEN, "0", "paid"]]);
      expect(await rows(c, "select kind, idem_key, match_id, to_address, amount::text as amount, usd::text as usd, status from public.payouts")).toEqual([
        { kind: "win", idem_key: `win:${id}`, match_id: id, to_address: ROOSTER, amount: "1450000000", usd: "7.2500", status: "pending" },
      ]);
      expect(await rows(c, "select tier_paid, quality_bps, payout::text as payout, payout_reason from public.matches where id = $1", [id])).toEqual([
        { tier_paid: "chrome", quality_bps: 10000, payout: "1450000000", payout_reason: "paid" },
      ]);
      // Half quality halves it; zero quality books nothing but records why.
      const half = await recordMatch(c, { tierPaid: "gold", q: 5000, winner: HEN });
      expect(half.find((x) => x.address === HEN)?.payout).toBe("1740000000");
      const none = await recordMatch(c, { tierPaid: "rust", q: 0 });
      expect(none[0]).toMatchObject({ payout: "0", payout_reason: "quality" });
      // A draw and an open (guest) match book nothing.
      expect((await recordMatch(c, { winner: null, reason: "draw" }))[0]?.payout_reason).toBe("draw");
      expect((await recordMatch(c, { tierPaid: null, q: null }))[0]?.payout_reason).toBe("open");
      expect(await rows(c, "select count(*)::int as n from public.payouts")).toEqual([{ n: 2 }]);
      // A retry of a booked match reports the same payout and books nothing more.
      const again = await recordMatch(c, { id, tierPaid: "chrome" });
      expect(again.map((x) => [x.address, x.payout, x.payout_reason])).toEqual([[ROOSTER, "1450000000", "paid"], [HEN, "0", "paid"]]);
      expect(await rows(c, "select count(*)::int as n from public.payouts")).toEqual([{ n: 2 }]);
    });
  });

  it("record_match books nothing without a pool state or for a flagged winner", async () => {
    await scratch(async (c) => {
      expect((await recordMatch(c, {}))[0]).toMatchObject({ payout: "0", payout_reason: "no_pool" });
      await setPool(c);
      await c.query("update public.players set flagged = true where address = $1", [ROOSTER]);
      expect((await recordMatch(c, {}))[0]).toMatchObject({ payout: "0", payout_reason: "flagged" });
      await c.query("update public.players set flagged = false where address = $1", [ROOSTER]);
      expect((await recordMatch(c, {}))[0]).toMatchObject({ payout_reason: "paid" });
    });
  });

  it("record_match applies the per-wallet caps: 10 paid matches a day against the same opponent", async () => {
    await scratch(async (c) => {
      await setPool(c);
      for (let i = 0; i < 10; i++) expect((await recordMatch(c, { winner: i % 2 ? HEN : ROOSTER }))[0]?.payout_reason).toBe("paid");
      expect((await recordMatch(c, {}))[0]).toMatchObject({ payout: "0", payout_reason: "cap_opponent" });
      // Against someone else it still pays; yesterday's matches don't count.
      expect((await recordMatch(c, { p2: CHICK }))[0]?.payout_reason).toBe("paid");
      expect((await recordMatch(c, { endedAgo: "1 day" }))[0]?.payout_reason).toBe("paid");
    });
  });

  it("record_match applies the per-wallet caps: 40 paid wins a day per wallet, IP or fingerprint", async () => {
    await scratch(async (c) => {
      await setPool(c);
      const others = Array.from({ length: 8 }, (_, i) => `${String.fromCharCode(65 + i)}${"1".repeat(43)}`);
      let n = 0;
      for (const o of others) for (let i = 0; i < 5; i++) {
        expect((await recordMatch(c, { p2: o, ip1: IP_A, fp1: FP_A }))[0]?.payout_reason, `win ${++n}`).toBe("paid");
      }
      expect((await recordMatch(c, { p2: CHICK }))[0]).toMatchObject({ payout: "0", payout_reason: "cap_wins" });
      // The same IP or fingerprint under another wallet is capped too; a clean wallet is not.
      expect((await recordMatch(c, { p1: CHICK, p2: HEN, ip1: IP_A }))[0]).toMatchObject({ payout_reason: "cap_wins" });
      expect((await recordMatch(c, { p1: CHICK, p2: HEN, fp1: FP_A }))[0]).toMatchObject({ payout_reason: "cap_wins" });
      expect((await recordMatch(c, { p1: CHICK, p2: HEN }))[0]).toMatchObject({ payout_reason: "paid" });
      // Losing under the capped IP is not a win.
      expect((await recordMatch(c, { p1: HEN, p2: CHICK, winner: CHICK, ip1: IP_A }))[1]).toMatchObject({ payout_reason: "paid" });
    });
  });

  it("treasury_window sums the ledger: claims, weighted matches, sends, outstanding, the seed and the allowance", async () => {
    await scratch(async (c) => {
      await setPool(c);
      let k = 0;
      const claim = (ago: string, gross: number) =>
        c.query("insert into public.fee_claims (stage, gross, player_share, project_share, sig, at) values ('curve', $1, $2, $3, $4, now() - $5::interval)", [
          gross, gross * 0.7, gross * 0.3, sig(String(++k)), ago,
        ]);
      await claim("1 hour", 1000);
      await claim("23 hours", 100);
      await claim("25 hours", 10000);
      await recordMatch(c, { tierPaid: "gold" }); // 6000 weight, books 3_480_000_000
      await recordMatch(c, { tierPaid: "rust", winner: HEN }); // 1000, books 580_000_000
      await recordMatch(c, { tierPaid: "chrome", endedAgo: "2 days" }); // outside the window; its payout still outstanding
      await c.query("update public.payouts set status = 'sent', tx_sig = $1, sent_at = now() - interval '10 minutes' where amount = 580000000", [sig("S")]);
      await c.query("insert into public.sweeps (sig, amount) values ($1, 50)", [sig("W")]);
      await c.query("update public.seed set original = 1400, remaining = 1400");
      await c.query("select public.book_seed_draw((now() at time zone 'UTC')::date, 60, 40, 500, $1)", [sig("D")]);
      const [w] = await rows<Record<string, string>>(c, "select * from public.treasury_window()");
      expect(w).toEqual({
        gross_24h: "1100",
        gross_today: expect.any(String),
        player_share_24h: "770",
        weighted_24h_milli: "7000",
        allowance: String(7770 + 100 - 580_000_000 - 50),
        sent_last_hour: "580000000",
        sent_today: "580000000",
        outstanding: String(3_480_000_000 + 1_450_000_000),
        seed_win: "60",
        seed_daily: "40",
        seed_total: "100",
      });
      expect(await rows(c, "select remaining::text as r from public.seed")).toEqual([{ r: "1300" }]);
      // A second draw for the day is refused; a top-up raises both figures.
      expect(await rows(c, "select public.book_seed_draw((now() at time zone 'UTC')::date, 1, 1, 1, null) as ok")).toEqual([{ ok: false }]);
      await c.query("select public.seed_topup(100)");
      expect(await rows(c, "select original::text as o, remaining::text as r from public.seed")).toEqual([{ o: "1500", r: "1400" }]);
    });
  });

  it("daily_ranking and book_daily: the closed day's top 10, flagged wallets left out, paid once", async () => {
    await scratch(async (c) => {
      await setPool(c);
      const day = "2026-09-20";
      const at = (h: number) => `${day}T${String(h).padStart(2, "0")}:00:00Z`;
      const ins = (p1: string, p2: string, winner: string, endedAt: string) =>
        c.query(
          `insert into public.matches (p1, p2, region, started_at, ended_at, winner, reason, rounds, tier_paid, payout, payout_reason)
           values ($1, $2, 'iad', $4::timestamptz - interval '3 minutes', $4, $3, 'ko', '[{"n":1}]', 'rust', 1, 'paid')`,
          [p1, p2, winner, endedAt],
        );
      for (const a of [ROOSTER, HEN, CHICK]) await c.query("insert into public.players (address) values ($1) on conflict do nothing", [a]);
      await ins(ROOSTER, HEN, ROOSTER, at(1));
      await ins(ROOSTER, HEN, ROOSTER, at(2));
      await ins(ROOSTER, HEN, HEN, at(3));
      await ins(HEN, CHICK, CHICK, at(4));
      await ins(HEN, CHICK, CHICK, at(5));
      await ins(HEN, CHICK, CHICK, `2026-09-21T00:00:00Z`); // next day
      await ins(HEN, CHICK, CHICK, `2026-09-19T23:59:59Z`); // day before
      expect(await rows(c, "select * from public.daily_ranking($1)", [day])).toEqual([
        { address: CHICK, wins: 2 }, // ties break on the address
        { address: ROOSTER, wins: 2 },
        { address: HEN, wins: 1 },
      ]);
      await c.query("update public.players set flagged = true where address = $1", [CHICK]);
      expect(await rows(c, "select * from public.daily_ranking($1)", [day])).toEqual([{ address: ROOSTER, wins: 2 }, { address: HEN, wins: 1 }]);

      const rewards = [
        { rank: 1, address: ROOSTER, wins: 2, share_bps: 2500, amount: 250_000_000 },
        { rank: 2, address: HEN, wins: 1, share_bps: 1800, amount: 180_000_000 },
      ];
      expect(await rows(c, "select public.book_daily($1, 5000000000, 0, 1000000000, $2) as n", [day, JSON.stringify(rewards)])).toEqual([{ n: 2 }]);
      expect(await rows(c, "select public.book_daily($1, 5000000000, 0, 1000000000, $2) as n", [day, JSON.stringify(rewards)])).toEqual([{ n: -1 }]);
      expect(await rows(c, "select idem_key, to_address, amount::text as amount, usd::text as usd from public.payouts order by rank")).toEqual([
        { idem_key: `daily:${day}:1`, to_address: ROOSTER, amount: "250000000", usd: "1.2500" },
        { idem_key: `daily:${day}:2`, to_address: HEN, amount: "180000000", usd: "0.9000" },
      ]);
      expect(await rows(c, "select day::text as day, rewards, pool::text as pool from public.daily_pools")).toEqual([{ day, rewards: 2, pool: "1000000000" }]);
      const pub = await as(c, "anon", () => rows(c, "select rank, display_name, amount::text as amount, status from public.daily_rewards_v order by rank"));
      expect(pub).toEqual([
        { rank: 1, display_name: `anon-${ROOSTER.slice(-4)}`, amount: "250000000", status: "pending" },
        { rank: 2, display_name: `anon-${HEN.slice(-4)}`, amount: "180000000", status: "pending" },
      ]);
      // An empty day is still booked (so midnight does not run twice).
      expect(await rows(c, "select public.book_daily('2026-09-18', 0, 0, 0, '[]') as n")).toEqual([{ n: 0 }]);
    });
  });

  it("claim_username sets the name with its signature, once per name (case-insensitive)", async () => {
    await scratch(async (c) => {
      await c.query("select public.claim_username($1, 'Rooster', $2)", [ROOSTER, sig("1")]);
      await c.query("select public.claim_username($1, 'Rooster2', $2)", [ROOSTER, sig("2")]); // a rename
      expect(await rows(c, "select username from public.players where address = $1", [ROOSTER])).toEqual([{ username: "Rooster2" }]);
      await expect(c.query("select public.claim_username($1, 'rooster2', $2)", [HEN, sig("3")])).rejects.toMatchObject({ code: "23505", constraint: "players_username_lower_key" });
      await expect(c.query("select public.claim_username($1, 'no way', $2)", [HEN, sig("3")])).rejects.toMatchObject({ code: "23514" });
    });
  });

  it("the new functions are service_role only", async () => {
    const c = await db.clone();
    try {
      for (const role of ["anon", "authenticated"] as const) {
        await expect(as(c, role, () => c.query("select * from public.treasury_window()"))).rejects.toMatchObject({ code: "42501" });
        await expect(as(c, role, () => c.query("select public.seed_topup(1)"))).rejects.toMatchObject({ code: "42501" });
        await expect(as(c, role, () => c.query("select public.claim_username($1, 'x', $2)", [ROOSTER, sig("1")]))).rejects.toMatchObject({ code: "42501" });
      }
    } finally {
      await c.close();
    }
  });
});
