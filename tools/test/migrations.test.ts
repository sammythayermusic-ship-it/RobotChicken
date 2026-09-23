import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PGlite, PGliteInterface } from "@electric-sql/pglite";
import { parse as parseToml } from "smol-toml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  API_ROLES,
  GRANT_MODES,
  SUPERUSER,
  applyMigrations,
  as,
  createCluster,
  freshDb,
  listMigrations,
  type ApiRole,
  type GrantMode,
} from "../src/db/harness";
import { repoPath } from "../src/root";

const BOOT_MS = 60_000;

const TABLES = [
  "abuse_events",
  "balance_checks",
  "daily_rewards",
  "fee_claims",
  "matches",
  "payouts",
  "players",
  "pool_snapshots",
] as const;
const VIEWS = ["leaderboard_v", "pool_v"] as const;
const PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN"] as const;

// Real 32-byte addresses (system program ids), so they are valid base58 too.
const ROOSTER = "So11111111111111111111111111111111111111112";
const HEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const CHICK = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
/** A syntactically valid 64-byte signature. */
const sig = (c: string): string => c.repeat(88);

type Row = Record<string, unknown>;

async function rows<T = Row>(db: PGliteInterface, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

async function one<T = Row>(db: PGliteInterface, sql: string, params: unknown[] = []): Promise<T> {
  const r = await rows<T>(db, sql, params);
  if (r.length !== 1) throw new Error(`expected one row, got ${r.length}: ${sql}`);
  return r[0] as T;
}

async function addPlayers(db: PGliteInterface, ...addresses: string[]): Promise<void> {
  for (const a of addresses) await db.query("insert into public.players (address) values ($1)", [a]);
}

interface MatchInput {
  p1: string;
  p2: string;
  winner?: string | null;
  reason?: string | null;
  endedAgo?: string | null;
  rounds?: unknown;
}

/** Insert a match; `endedAgo` is an interval before now(), null for an unfinished match. */
async function addMatch(db: PGliteInterface, m: MatchInput): Promise<string> {
  const ended = m.endedAgo === undefined ? "0 seconds" : m.endedAgo;
  const reason = m.reason === undefined ? (m.winner ? "ko" : ended === null ? null : "draw") : m.reason;
  const r = await one<{ id: string }>(
    db,
    `insert into public.matches (p1, p2, region, winner, reason, ended_at, rounds, input_log, result_hash)
     values ($1, $2, 'iad', $3, $4, now() - $5::interval, $6::jsonb, $7, repeat('ab', 32))
     returning id`,
    [m.p1, m.p2, m.winner ?? null, reason, ended, JSON.stringify(m.rounds ?? (ended === null ? [] : [{ winner: 0 }])), new Uint8Array([1, 2, 3])],
  );
  return r.id;
}

async function relPrivileges(db: PGliteInterface, rel: string, role: string): Promise<string[]> {
  const out: string[] = [];
  for (const p of PRIVILEGES) {
    const r = await one<{ ok: boolean }>(db, "select has_table_privilege($1, $2, $3) as ok", [role, `public.${rel}`, p]);
    if (r.ok) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------

describe("PGlite capability probe", () => {
  // Proves the features the migrations rely on work in PGlite at all, on
  // scratch objects, before the real migrations are tested below.
  let db: PGlite;

  beforeAll(async () => {
    db = await createCluster("strict");
    await as(db, "postgres", () =>
      db.exec(`
        create schema probe;
        grant usage on schema probe to anon, authenticated, service_role;
        create table probe.t (
          id uuid primary key default gen_random_uuid(),
          owner text not null,
          doc jsonb not null default '{}' check (jsonb_typeof(doc) = 'object'),
          blob bytea
        );
        alter table probe.t enable row level security;
        insert into probe.t (owner, doc, blob) values ('a', '{"k": [1, 2]}', '\\x00ff'), ('b', '{}', null);
      `),
    );
  }, BOOT_MS);
  afterAll(() => db?.close());

  it("runs Postgres 17+ with Supabase's role layout", async () => {
    const v = await one<{ n: number }>(db, "select current_setting('server_version_num')::int as n");
    expect(v.n).toBeGreaterThanOrEqual(170000);
    const roles = await rows(
      db,
      `select rolname, rolsuper, rolinherit, rolcanlogin, rolbypassrls from pg_roles
       where rolname in ('postgres', 'anon', 'authenticated', 'service_role', $1) order by rolname`,
      [SUPERUSER],
    );
    expect(roles).toEqual([
      { rolname: "anon", rolsuper: false, rolinherit: false, rolcanlogin: false, rolbypassrls: false },
      { rolname: "authenticated", rolsuper: false, rolinherit: false, rolcanlogin: false, rolbypassrls: false },
      { rolname: "postgres", rolsuper: false, rolinherit: true, rolcanlogin: true, rolbypassrls: true },
      { rolname: "service_role", rolsuper: false, rolinherit: false, rolcanlogin: false, rolbypassrls: true },
      { rolname: SUPERUSER, rolsuper: true, rolinherit: true, rolcanlogin: true, rolbypassrls: true },
    ]);
  });

  it("supports gen_random_uuid(), jsonb, bytea and check constraints", async () => {
    const r = await one<{ id: string; doc: unknown; blob: Uint8Array }>(db, "select id, doc, blob from probe.t where owner = 'a'");
    expect(r.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(r.doc).toEqual({ k: [1, 2] });
    expect(Array.from(r.blob)).toEqual([0, 255]);
    await expect(db.query("insert into probe.t (owner, doc) values ('c', '[]')")).rejects.toMatchObject({
      code: "23514",
      constraint: "t_doc_check",
    });
  });

  it("enforces GRANT/REVOKE and RLS under SET ROLE", async () => {
    await expect(as(db, "anon", () => db.query("select * from probe.t"))).rejects.toMatchObject({ code: "42501" });
    await as(db, "postgres", () => db.exec("grant select on probe.t to anon, service_role"));
    // Granted but RLS on with no policy: anon sees nothing, BYPASSRLS and the owner see all.
    expect(await as(db, "anon", () => rows(db, "select * from probe.t"))).toEqual([]);
    expect(await as(db, "service_role", () => rows(db, "select * from probe.t"))).toHaveLength(2);
    expect(await as(db, "postgres", () => rows(db, "select * from probe.t"))).toHaveLength(2);
    await as(db, "postgres", () => db.exec("revoke select on probe.t from anon"));
    await expect(as(db, "anon", () => db.query("select * from probe.t"))).rejects.toMatchObject({ code: "42501" });
    // as() restores the previous role, including after an error and when nested.
    expect(await one(db, "select current_user as u")).toEqual({ u: SUPERUSER });
    const nested = await as(db, "postgres", async () => {
      const inner = await as(db, "anon", () => one(db, "select current_user as u"));
      return [inner, await one(db, "select current_user as u")];
    });
    expect(nested).toEqual([{ u: "anon" }, { u: "postgres" }]);
  });

  it("applies ALTER DEFAULT PRIVILEGES FOR ROLE postgres to later tables", async () => {
    await as(db, "postgres", () =>
      db.exec(`
        alter default privileges for role postgres in schema probe grant select on tables to authenticated;
        create table probe.after_grant (id int);
        alter default privileges for role postgres in schema probe revoke select on tables from authenticated;
        create table probe.after_revoke (id int);
      `),
    );
    const priv = (t: string) => one<{ ok: boolean }>(db, "select has_table_privilege('authenticated', $1, 'SELECT') as ok", [t]);
    expect(await priv("probe.after_grant")).toEqual({ ok: true });
    expect(await priv("probe.after_revoke")).toEqual({ ok: false });
  });

  it("refreshes a materialized view CONCURRENTLY only with a unique index; MAINTAIN lets a non-owner refresh", async () => {
    await as(db, "postgres", () => db.exec("create materialized view probe.mv as select owner, count(*) as n from probe.t group by owner"));
    const refresh = () => db.exec("refresh materialized view concurrently probe.mv");
    await expect(as(db, "postgres", refresh)).rejects.toMatchObject({ code: "55000" });
    await as(db, "postgres", () => db.exec("create unique index on probe.mv (owner)"));
    await as(db, "postgres", refresh);
    await expect(as(db, "service_role", refresh)).rejects.toMatchObject({ code: "42501" });
    await as(db, "postgres", () => db.exec("grant maintain on probe.mv to service_role"));
    await as(db, "service_role", refresh);
    expect(await as(db, "postgres", () => rows(db, "select owner, n from probe.mv order by owner"))).toEqual([
      { owner: "a", n: 1 },
      { owner: "b", n: 1 },
    ]);
  });

  it("owner-rights views read RLS tables for roles without table grants; invoker views do not", async () => {
    await as(db, "postgres", () =>
      db.exec(`
        create view probe.definer_v as select count(*)::int as n from probe.t;
        create view probe.invoker_v with (security_invoker = true) as select count(*)::int as n from probe.t;
        grant select on probe.definer_v, probe.invoker_v to anon;
      `),
    );
    expect(await as(db, "anon", () => one(db, "select n from probe.definer_v"))).toEqual({ n: 2 });
    await expect(as(db, "anon", () => db.query("select n from probe.invoker_v"))).rejects.toMatchObject({ code: "42501" });
  });

  it("has no pg_cron (the cron migration must be a no-op here)", async () => {
    expect(await rows(db, "select name from pg_available_extensions where name = 'pg_cron'")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("migration files and the harness", () => {
  it("are named the way the Supabase CLI expects, in version order", () => {
    expect(listMigrations().map((m) => m.name)).toEqual(["20260923000000_init.sql", "20260923000100_cron.sql"]);
  });

  it("listMigrations() rejects a file the CLI would silently skip", () => {
    const dir = mkdtempSync(join(tmpdir(), "cf-migrations-"));
    try {
      writeFileSync(join(dir, "20260923000000_ok.sql"), "select 1;");
      writeFileSync(join(dir, "2026_bad.sql"), "select 1;");
      expect(() => listMigrations(dir)).toThrow(/2026_bad\.sql/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("use nothing that only Postgres 18 has (PGlite runs 18, Supabase runs 17)", () => {
    // A tripwire, not a parser: PGlite would accept these, Supabase would not.
    const pg18Only = [
      /\buuidv7\s*\(/i,
      /\buuid_extract_(version|timestamp)\s*\(/i,
      /\bvirtual\b/i, // virtual generated columns
      /\bwithout\s+overlaps\b/i, // temporal keys
      /\bnot\s+enforced\b/i,
      /\bcasefold\s*\(/i,
      /\breturning\b[^;]*\b(old|new)\s*\./i,
    ];
    for (const m of listMigrations()) {
      const code = m.sql.replace(/--.*$/gm, "");
      for (const re of pg18Only) expect(code, `${m.name} matches ${re}`).not.toMatch(re);
    }
  });

  it("config.toml pins the project and Postgres 17 and disables the seed", () => {
    const cfg = parseToml(readFileSync(repoPath("supabase", "config.toml"), "utf8")) as {
      project_id?: unknown;
      db?: { major_version?: unknown; seed?: { enabled?: unknown } };
    };
    expect(cfg.project_id).toBe("cockfight");
    expect(cfg.db?.major_version).toBe(17);
    expect(cfg.db?.seed?.enabled).toBe(false);
  });

  it("the harness's legacy mode auto-grants new tables to the API roles and strict mode does not", async () => {
    // Without this, "the same in both modes" below would prove nothing.
    for (const mode of GRANT_MODES) {
      const db = await createCluster(mode);
      try {
        await as(db, "postgres", () => db.exec("create table public.t (id int)"));
        for (const role of API_ROLES) {
          expect(await relPrivileges(db, "t", role), `${mode} ${role}`).toEqual(mode === "legacy" ? [...PRIVILEGES] : []);
        }
      } finally {
        await db.close();
      }
    }
  }, BOOT_MS);

  it("freshDb() boots a migrated database", async () => {
    const db = await freshDb("strict");
    try {
      expect(await one(db, "select count(*)::int as n from public.leaderboard_v")).toEqual({ n: 0 });
    } finally {
      await db.close();
    }
  }, BOOT_MS);
});

describe.each(GRANT_MODES)("migrations on a %s-grants project", (mode: GrantMode) => {
  let db: PGlite;
  let notices: string[];

  beforeAll(async () => {
    db = await createCluster(mode);
    notices = (await applyMigrations(db)).map((n) => `${n.severity}: ${n.message}`);
  }, BOOT_MS);
  afterAll(() => db?.close());

  /** A private copy for tests that write, so every test starts from the migrated schema. */
  async function scratch<T>(fn: (c: PGliteInterface) => Promise<T>): Promise<T> {
    const c = await db.clone();
    try {
      return await fn(c);
    } finally {
      await c.close();
    }
  }

  it("creates exactly the 8 tables and 2 views, owned by postgres", async () => {
    const rels = await rows(
      db,
      `select c.relname, c.relkind, pg_get_userbyid(c.relowner) as owner from pg_class c
       where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
       order by c.relname`,
    );
    expect(rels).toEqual(
      [
        ...TABLES.map((relname) => ({ relname, relkind: "r", owner: "postgres" })),
        { relname: "leaderboard_v", relkind: "m", owner: "postgres" },
        { relname: "pool_v", relkind: "v", owner: "postgres" },
      ].sort((a, b) => a.relname.localeCompare(b.relname)),
    );
  });

  it("matches the column contract (update this and the shared row types together)", async () => {
    // "!" marks NOT NULL. The two domains are text with a base58 check.
    const cols = await rows<{ t: string; cols: string }>(
      db,
      `select c.relname as t, string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
                                         || case when a.attnotnull then '!' else '' end, ', ' order by a.attnum) as cols
       from pg_class c join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
       where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'v', 'm')
       group by c.relname order by c.relname`,
    );
    const ts = "timestamp with time zone";
    expect(Object.fromEntries(cols.map((r) => [r.t, r.cols]))).toEqual({
      abuse_events: `id uuid!, address sol_address, fingerprint text, ip_hash text, kind text!, match_id uuid, details jsonb!, created_at ${ts}!, resolved_by text, resolved_at ${ts}`,
      balance_checks: `id uuid!, address sol_address!, usd numeric(14,4)!, tokens numeric(30,9)!, source text!, checked_at ${ts}!`,
      daily_rewards: "day date!, rank smallint!, address sol_address!, wins integer!, elo integer!, pool_lamports bigint!, share_bps integer!, lamports bigint!, payout_id uuid",
      fee_claims: `id uuid!, stage text!, gme_claimed numeric(40,0)!, cock_claimed numeric(40,0)!, sol_after_swap bigint, player_share_lamports bigint, project_share_gme numeric(40,0), claim_sig sol_signature, swap_sig sol_signature, at ${ts}!`,
      leaderboard_v: `address sol_address, display_name text, elo integer, tier text, wins_today integer, matches_today integer, wins_7d integer, matches_7d integer, win_rate_7d numeric, earned_lamports_7d bigint, wins_all integer, matches_all integer, win_rate_all numeric, earned_lamports_all bigint, refreshed_at ${ts}`,
      matches: `id uuid!, p1 sol_address!, p2 sol_address!, region text!, started_at ${ts}!, ended_at ${ts}, winner sol_address, reason text, rounds jsonb!, input_log bytea, result_hash text, net_quality_p1 real, net_quality_p2 real, payout_lamports bigint!, flag text`,
      payouts: `id uuid!, kind text!, idem_key text!, match_id uuid, to_address sol_address!, lamports bigint!, status text!, tx_sig sol_signature, attempts integer!, next_attempt_at ${ts}, last_error text, created_at ${ts}!, paid_at ${ts}`,
      players: `address sol_address!, username text, username_sig sol_signature, elo integer!, tier text, first_seen ${ts}!, last_seen ${ts}!, flags jsonb!`,
      pool_snapshots: `at ${ts}!, creator_balance_gme numeric(40,0)!, hot_balance bigint!, matches_24h integer!, payout_per_win bigint!, daily_pool_lamports bigint!, market_cap_usd numeric(20,2)`,
      pool_v: `snapshot_at ${ts}, creator_balance_gme numeric(40,0), hot_balance bigint, matches_24h integer, payout_per_win bigint, daily_pool_lamports bigint, market_cap_usd numeric(20,2), claims_24h integer, gme_claimed_24h numeric, cock_claimed_24h numeric, sol_after_swap_24h bigint, player_share_lamports_24h bigint, project_share_gme_24h numeric, paid_count_24h integer, paid_lamports_24h bigint, computed_at ${ts}`,
    });
  });

  it("enables (not forces) RLS on every table, with no policies", async () => {
    const t = await rows(
      db,
      `select relname, relrowsecurity, relforcerowsecurity from pg_class
       where relnamespace = 'public'::regnamespace and relkind in ('r', 'p') order by relname`,
    );
    expect(t).toEqual(TABLES.map((relname) => ({ relname, relrowsecurity: true, relforcerowsecurity: false })));
    expect(await one(db, "select count(*)::int as n from pg_policies where schemaname = 'public'")).toEqual({ n: 0 });
  });

  it("grants exactly the intended privileges, the same in both grant modes", async () => {
    const readWrite = ["SELECT", "INSERT", "UPDATE"];
    const expected: Record<string, Record<ApiRole, string[]>> = {
      abuse_events: { anon: [], authenticated: [], service_role: readWrite },
      balance_checks: { anon: [], authenticated: [], service_role: ["SELECT", "INSERT", "DELETE"] },
      daily_rewards: { anon: [], authenticated: [], service_role: readWrite },
      fee_claims: { anon: [], authenticated: [], service_role: readWrite },
      matches: { anon: [], authenticated: [], service_role: readWrite },
      payouts: { anon: [], authenticated: [], service_role: readWrite },
      players: { anon: [], authenticated: [], service_role: readWrite },
      pool_snapshots: { anon: [], authenticated: [], service_role: ["SELECT", "INSERT", "UPDATE", "DELETE"] },
      leaderboard_v: { anon: ["SELECT"], authenticated: ["SELECT"], service_role: ["SELECT", "MAINTAIN"] },
      pool_v: { anon: ["SELECT"], authenticated: ["SELECT"], service_role: ["SELECT"] },
    };
    const actual: Record<string, Record<string, string[]>> = {};
    for (const rel of [...TABLES, ...VIEWS]) {
      const byRole: Record<string, string[]> = {};
      for (const role of API_ROLES) byRole[role] = await relPrivileges(db, rel, role);
      actual[rel] = byRole;
    }
    expect(actual).toEqual(expected);
  });

  it("makes later tables and sequences private to the web keys, writable by service_role", async () => {
    await scratch(async (c) => {
      await as(c, "postgres", () => c.exec("create table public.later (id int); create sequence public.later_seq;"));
      expect(await relPrivileges(c, "later", "anon")).toEqual([]);
      expect(await relPrivileges(c, "later", "authenticated")).toEqual([]);
      expect(await relPrivileges(c, "later", "service_role")).toEqual(["SELECT", "INSERT", "UPDATE", "DELETE"]);
      const seq = (role: string, p: string) =>
        one<{ ok: boolean }>(c, "select has_sequence_privilege($1, 'public.later_seq', $2) as ok", [role, p]);
      expect(await seq("anon", "USAGE")).toEqual({ ok: false });
      expect(await seq("authenticated", "SELECT")).toEqual({ ok: false });
      expect(await seq("service_role", "USAGE")).toEqual({ ok: true });
    });
  });

  it("denies anon and authenticated every base table, even to read", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      for (const t of TABLES) {
        for (const sql of [`select * from public.${t}`, `insert into public.${t} default values`, `delete from public.${t}`]) {
          await expect(as(db, role, () => db.query(sql)), `${role}: ${sql}`).rejects.toMatchObject({ code: "42501" });
        }
      }
      await expect(as(db, role, () => db.query("update public.payouts set status = 'paid'"))).rejects.toMatchObject({ code: "42501" });
      await expect(
        as(db, role, () => db.exec("refresh materialized view concurrently public.leaderboard_v")),
      ).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("lets anon and authenticated read both views, which expose no private columns", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      expect(await as(db, role, () => rows(db, "select * from public.leaderboard_v"))).toEqual([]);
      const pool = await as(db, role, () => rows(db, "select * from public.pool_v"));
      expect(pool).toHaveLength(1);
      expect(pool[0]).toMatchObject({
        snapshot_at: null,
        payout_per_win: null,
        claims_24h: 0,
        paid_count_24h: 0,
        paid_lamports_24h: 0,
        player_share_lamports_24h: 0,
      });
    }
    const cols = await rows<{ c: string }>(
      db,
      `select attname as c from pg_attribute
       where attrelid in ('public.leaderboard_v'::regclass, 'public.pool_v'::regclass) and attnum > 0`,
    );
    const exposed = cols.map((r) => r.c);
    for (const secret of ["ip_hash", "fingerprint", "flags", "username_sig", "input_log", "details"]) {
      expect(exposed).not.toContain(secret);
    }
    // pool_v reads with its owner's rights on purpose (not security_invoker).
    expect(await one(db, "select reloptions from pg_class where oid = 'public.pool_v'::regclass")).toEqual({
      reloptions: ["security_barrier=true"],
    });
  });

  it("lets service_role write and read every table (RLS bypassed)", async () => {
    await scratch(async (c) => {
      await as(c, "service_role", async () => {
        await addPlayers(c, ROOSTER, HEN);
        await c.query("update public.players set username = 'Rooster', username_sig = $1, tier = 'gold' where address = $2", [sig("5"), ROOSTER]);
        await c.query("insert into public.balance_checks (address, usd, tokens, source) values ($1, 31.5, 123456.000000001, 'jupiter')", [ROOSTER]);
        const matchId = await addMatch(c, { p1: ROOSTER, p2: HEN, winner: ROOSTER });
        const win = await one<{ id: string }>(
          c,
          "insert into public.payouts (kind, idem_key, match_id, to_address, lamports) values ('win', $1, $2, $3, 41000000) returning id",
          [matchId, matchId, ROOSTER],
        );
        await c.query("update public.payouts set status = 'sent', tx_sig = $1, attempts = 1 where id = $2", [sig("6"), win.id]);
        await c.query("update public.payouts set status = 'paid', paid_at = now() where id = $1", [win.id]);
        const daily = await one<{ id: string }>(
          c,
          "insert into public.payouts (kind, idem_key, to_address, lamports) values ('daily', '2026-09-23:1', $1, 2500000000) returning id",
          [ROOSTER],
        );
        await c.query(
          `insert into public.daily_rewards (day, rank, address, wins, elo, pool_lamports, share_bps, lamports, payout_id)
           values ('2026-09-23', 1, $1, 40, 1016, 10000000000, 2500, 2500000000, $2)`,
          [ROOSTER, daily.id],
        );
        await c.query(
          `insert into public.fee_claims (stage, gme_claimed, sol_after_swap, player_share_lamports, project_share_gme, claim_sig, swap_sig)
           values ('dbc', 123456789012345678901234567890, 88000000000, 61600000000, 37037036703703703670370370367, $1, $2)`,
          [sig("7"), sig("8")],
        );
        await c.query(
          `insert into public.pool_snapshots (creator_balance_gme, hot_balance, matches_24h, payout_per_win, daily_pool_lamports, market_cap_usd)
           values (5, 1000000000, 1500, 29000000, 17600000000, 500000.25)`,
        );
        await c.query(
          "insert into public.abuse_events (address, fingerprint, ip_hash, kind, match_id, details) values ($1, 'fp', 'ih', 'self_match', $2, $3)",
          [HEN, matchId, JSON.stringify({ sameSubnet: true })],
        );
        await c.query("update public.abuse_events set resolved_by = 'sammy', resolved_at = now()");
        const counts: Record<string, number> = {};
        for (const t of TABLES) counts[t] = (await one<{ n: number }>(c, `select count(*)::int as n from public.${t}`)).n;
        expect(counts).toEqual({
          abuse_events: 1,
          balance_checks: 1,
          daily_rewards: 1,
          fee_claims: 1,
          matches: 1,
          payouts: 2,
          players: 2,
          pool_snapshots: 1,
        });
        // Retention deletes where granted; money rows are never deleted or truncated.
        await c.query("delete from public.pool_snapshots");
        await c.query("delete from public.balance_checks");
        await expect(c.query("delete from public.payouts")).rejects.toMatchObject({ code: "42501" });
        await expect(c.query("delete from public.matches")).rejects.toMatchObject({ code: "42501" });
        await expect(c.query("truncate public.fee_claims")).rejects.toMatchObject({ code: "42501" });
        // MAINTAIN lets the worker refresh the leaderboard itself.
        await c.exec("refresh materialized view concurrently public.leaderboard_v");
      });
      const lb = await one(c, "select display_name, tier, wins_all, earned_lamports_all from public.leaderboard_v where address = $1", [ROOSTER]);
      expect(lb).toEqual({ display_name: "Rooster", tier: "gold", wins_all: 1, earned_lamports_all: 41000000 });
    });
  });

  it("stores a drawn match and rejects inconsistent results", async () => {
    await scratch(async (c) => {
      await addPlayers(c, ROOSTER, HEN, CHICK);
      const draw = await addMatch(c, { p1: ROOSTER, p2: HEN, winner: null, reason: "draw", rounds: [{}, {}, {}, {}, {}] });
      expect(await one(c, "select winner, reason from public.matches where id = $1", [draw])).toEqual({ winner: null, reason: "draw" });
      await addMatch(c, { p1: ROOSTER, p2: HEN, endedAgo: null }); // unfinished: no result yet

      const bad: [MatchInput, string][] = [
        [{ p1: ROOSTER, p2: HEN, winner: ROOSTER, reason: "draw" }, "matches_winner_iff_decisive"],
        [{ p1: ROOSTER, p2: HEN, winner: null, reason: "ko" }, "matches_winner_iff_decisive"],
        [{ p1: ROOSTER, p2: HEN, winner: null, reason: "forfeit" }, "matches_winner_iff_decisive"],
        [{ p1: ROOSTER, p2: HEN, winner: CHICK, reason: "ko" }, "matches_winner_is_player"],
        [{ p1: ROOSTER, p2: ROOSTER, winner: ROOSTER }, "matches_distinct_players"],
        [{ p1: ROOSTER, p2: HEN, winner: ROOSTER, reason: "doubleko" }, "matches_reason_check"],
        [{ p1: ROOSTER, p2: HEN, winner: null, reason: "draw", endedAgo: null }, "matches_ended_has_reason"],
        [{ p1: ROOSTER, p2: HEN, winner: ROOSTER, reason: null }, "matches_ended_has_reason"],
        [{ p1: ROOSTER, p2: HEN, winner: ROOSTER, rounds: [] }, "matches_rounds_shape"],
        [{ p1: ROOSTER, p2: HEN, winner: ROOSTER, rounds: [{}, {}, {}, {}, {}, {}] }, "matches_rounds_shape"],
        [{ p1: ROOSTER, p2: HEN, winner: ROOSTER, rounds: { r: 1 } }, "matches_rounds_shape"],
      ];
      for (const [m, constraint] of bad) {
        await expect(addMatch(c, m), JSON.stringify(m)).rejects.toMatchObject({ code: "23514", constraint });
      }
    });
  });

  it("keeps payouts idempotent and consistent", async () => {
    await scratch(async (c) => {
      await addPlayers(c, ROOSTER, HEN);
      const won = await addMatch(c, { p1: ROOSTER, p2: HEN, winner: ROOSTER });
      const drawn = await addMatch(c, { p1: ROOSTER, p2: HEN, winner: null, reason: "draw" });
      const pay = (kind: string, key: string, matchId: string | null, to: string) =>
        c.query("insert into public.payouts (kind, idem_key, match_id, to_address, lamports) values ($1, $2, $3, $4, 1000)", [kind, key, matchId, to]);

      await pay("win", won, won, ROOSTER);
      await expect(pay("win", won, won, ROOSTER)).rejects.toMatchObject({ code: "23505", constraint: "payouts_idem_key_key" });
      await pay("daily", "2026-09-23:10", null, HEN);
      await expect(pay("daily", "2026-09-23:10", null, ROOSTER)).rejects.toMatchObject({ code: "23505", constraint: "payouts_idem_key_key" });

      // Win payouts: keyed on the match, only to its winner, never for a draw.
      await expect(pay("win", "not-the-match-id", won, ROOSTER)).rejects.toMatchObject({ code: "23514", constraint: "payouts_kind_key" });
      await expect(pay("win", won, null, ROOSTER)).rejects.toMatchObject({ code: "23514", constraint: "payouts_kind_key" });
      const lost = await addMatch(c, { p1: ROOSTER, p2: HEN, winner: HEN });
      await expect(pay("win", lost, lost, ROOSTER)).rejects.toMatchObject({ code: "23503", constraint: "payouts_win_to_winner" });
      await expect(pay("win", drawn, drawn, ROOSTER)).rejects.toMatchObject({ code: "23503", constraint: "payouts_win_to_winner" });
      const ghost = "00000000-0000-4000-8000-000000000000";
      await expect(pay("win", ghost, ghost, ROOSTER)).rejects.toMatchObject({ code: "23503", constraint: "payouts_win_to_winner" });
      // With a payout recorded, the match's winner cannot change and the match cannot go.
      await expect(c.query("update public.matches set winner = $1 where id = $2", [HEN, won])).rejects.toMatchObject({ code: "23503" });
      await expect(c.query("delete from public.matches where id = $1", [won])).rejects.toMatchObject({ code: "23503" });

      // Daily payouts: "YYYY-MM-DD:rank" with rank 1..10, and no match.
      for (const key of ["2026-09-23:0", "2026-09-23:11", "2026-9-23:1", "2026-09-23", "x"]) {
        await expect(pay("daily", key, null, HEN), key).rejects.toMatchObject({ code: "23514", constraint: "payouts_kind_key" });
      }
      await expect(pay("daily", "2026-09-24:1", won, ROOSTER)).rejects.toMatchObject({ code: "23514", constraint: "payouts_kind_key" });
      await expect(pay("tip", "2026-09-24:1", null, HEN)).rejects.toMatchObject({ code: "23514", constraint: "payouts_kind_check" });

      // Status enumeration and the sent/paid invariants.
      const setStatus = (s: string) => c.query("update public.payouts set status = $1 where idem_key = $2", [s, won]);
      await expect(setStatus("refunded")).rejects.toMatchObject({ code: "23514", constraint: "payouts_status_check" });
      await expect(setStatus("sent")).rejects.toMatchObject({ code: "23514", constraint: "payouts_sig_when_sent" });
      await expect(setStatus("paid")).rejects.toMatchObject({ code: "23514", constraint: "payouts_paid_at_iff_paid" });
      for (const s of ["deferred", "failed", "voided", "pending"]) await setStatus(s);
      await expect(
        c.query("update public.payouts set status = 'paid', tx_sig = $1 where idem_key = $2", [sig("9"), won]),
      ).rejects.toMatchObject({ code: "23514", constraint: "payouts_paid_at_iff_paid" });
      await c.query("update public.payouts set status = 'paid', tx_sig = $1, paid_at = now() where idem_key = $2", [sig("9"), won]);
      // One transaction signature settles one payout.
      await expect(
        c.query("update public.payouts set status = 'sent', tx_sig = $1 where idem_key = '2026-09-23:10'", [sig("9")]),
      ).rejects.toMatchObject({ code: "23505", constraint: "payouts_tx_sig_key" });
      await expect(c.query("update public.payouts set attempts = -1")).rejects.toMatchObject({ code: "23514", constraint: "payouts_attempts_check" });
      await expect(c.query("update public.payouts set lamports = -1")).rejects.toMatchObject({ code: "23514", constraint: "payouts_lamports_check" });
    });
  });

  it("validates addresses, signatures, enumerations and amounts in every table", async () => {
    await scratch(async (c) => {
      for (const a of ["So1111111111111111111111111111111111111111O", "So11111111111111111111111111111111111111l12", "So11", "x".repeat(45)]) {
        await expect(addPlayers(c, a), a).rejects.toMatchObject({ code: "23514", constraint: "sol_address_check" });
      }
      await addPlayers(c, ROOSTER, HEN);
      const rejects = (constraint: string, sql: string, params: unknown[] = []) =>
        expect(c.query(sql, params), sql).rejects.toMatchObject({ code: "23514", constraint });
      await rejects("players_username_check", "update public.players set username = 'no spaces', username_sig = $1", [sig("2")]);
      await rejects("players_username_signed", "update public.players set username = 'Rooster'");
      await rejects("sol_signature_check", "update public.players set username = 'Rooster', username_sig = 'short'");
      await rejects("players_tier_check", "update public.players set tier = 'platinum'");
      await rejects("players_flags_check", "update public.players set flags = '[]'");
      await c.query("update public.players set username = 'Rooster', username_sig = $1 where address = $2", [sig("2"), ROOSTER]);
      await expect(
        c.query("update public.players set username = 'ROOSTER', username_sig = $1 where address = $2", [sig("3"), HEN]),
      ).rejects.toMatchObject({ code: "23505", constraint: "players_username_lower_key" });

      const check = "insert into public.balance_checks (address, usd, tokens, source)";
      await rejects("balance_checks_source_check", `${check} values ($1, 1, 1, 'birdeye')`, [ROOSTER]);
      await rejects("balance_checks_usd_check", `${check} values ($1, -1, 1, 'curve')`, [ROOSTER]);
      await rejects("sol_address_check", `${check} values ('0x0', 1, 1, 'curve')`);

      const match = "insert into public.matches (p1, p2, region";
      await rejects("matches_region_check", `${match}) values ($1, $2, 'US-EAST')`, [ROOSTER, HEN]);
      await rejects("matches_payout_lamports_check", `${match}, payout_lamports) values ($1, $2, 'iad', -1)`, [ROOSTER, HEN]);
      await rejects("matches_result_hash_check", `${match}, result_hash) values ($1, $2, 'iad', 'ABC')`, [ROOSTER, HEN]);
      await rejects("matches_net_quality_p1_check", `${match}, net_quality_p1) values ($1, $2, 'iad', 1.5)`, [ROOSTER, HEN]);
      await rejects("matches_input_log_check", `${match}, input_log) values ($1, $2, 'iad', $3)`, [ROOSTER, HEN, new Uint8Array(1048577)]);

      await rejects("fee_claims_stage_check", "insert into public.fee_claims (stage) values ('pumpfun')");
      await rejects("fee_claims_gme_claimed_check", "insert into public.fee_claims (stage, gme_claimed) values ('dbc', -1)");
      await rejects("sol_signature_check", "insert into public.fee_claims (stage, claim_sig) values ('dbc', $1)", [ROOSTER]);

      const snapshot = "insert into public.pool_snapshots (at, creator_balance_gme, hot_balance, matches_24h, payout_per_win, daily_pool_lamports)";
      const minute = "date_trunc('minute', now(), 'UTC')";
      await rejects("pool_snapshots_whole_minute", `${snapshot} values (${minute} + interval '1 second', 0, 0, 0, 0, 0)`);
      await rejects("pool_snapshots_hot_balance_check", `${snapshot} values (${minute}, 0, -1, 0, 0, 0)`);

      await rejects("abuse_events_kind_check", "insert into public.abuse_events (kind) values ('Self Match')");
      await rejects("abuse_events_resolution", "insert into public.abuse_events (kind, resolved_by) values ('bot', 'sammy')");
      await rejects("abuse_events_details_check", "insert into public.abuse_events (kind, details) values ('bot', '1')");

      const reward = (rank: number, share: number, lamports: number) =>
        c.query(
          `insert into public.daily_rewards (day, rank, address, wins, elo, pool_lamports, share_bps, lamports)
           values ('2026-09-23', $1, $2, 1, 1000, 1000, $3, $4)`,
          [rank, ROOSTER, share, lamports],
        );
      await expect(reward(11, 100, 10)).rejects.toMatchObject({ code: "23514", constraint: "daily_rewards_rank_check" });
      await expect(reward(1, 10001, 10)).rejects.toMatchObject({ code: "23514", constraint: "daily_rewards_share_bps_check" });
      await expect(reward(1, 100, 1001)).rejects.toMatchObject({ code: "23514", constraint: "daily_rewards_within_pool" });
      await reward(1, 2500, 250);
      // One row per address per day.
      await expect(reward(2, 1800, 180)).rejects.toMatchObject({ code: "23505", constraint: "daily_rewards_day_address_key" });
    });
  });

  it("aggregates leaderboard_v per address after REFRESH ... CONCURRENTLY", async () => {
    await scratch(async (c) => {
      await addPlayers(c, ROOSTER, HEN, CHICK);
      await c.query("update public.players set username = 'Rooster', username_sig = $1, elo = 1032 where address = $2", [sig("4"), ROOSTER]);
      const today = await addMatch(c, { p1: ROOSTER, p2: HEN, winner: ROOSTER });
      await addMatch(c, { p1: HEN, p2: ROOSTER, winner: HEN, endedAgo: "3 days" });
      await addMatch(c, { p1: ROOSTER, p2: CHICK, winner: null, reason: "draw" });
      const old = await addMatch(c, { p1: CHICK, p2: ROOSTER, winner: CHICK, reason: "ringout", endedAgo: "10 days" });
      await addMatch(c, { p1: HEN, p2: CHICK, endedAgo: null }); // unfinished: counts for nobody
      let n = 0;
      const payout = (key: string, matchId: string | null, to: string, lamports: number, paidAgo: string | null) =>
        c.query(
          `insert into public.payouts (kind, idem_key, match_id, to_address, lamports, status, tx_sig, paid_at)
           values ($1, $2, $3, $4, $5, $6, $7, now() - $8::interval)`,
          [matchId ? "win" : "daily", key, matchId, to, lamports, paidAgo ? "paid" : "pending", paidAgo ? sig(String(++n)) : null, paidAgo],
        );
      await payout(today, today, ROOSTER, 1000, "1 day");
      await payout("2026-09-01:1", null, ROOSTER, 500, "20 days");
      await payout("2026-09-22:3", null, ROOSTER, 7777, null); // pending: not earned yet
      await payout(old, old, CHICK, 300, "10 days");

      // Before a refresh the view still shows the old (empty) snapshot.
      expect(await rows(c, "select * from public.leaderboard_v")).toEqual([]);
      await as(c, "postgres", () => c.exec("refresh materialized view concurrently public.leaderboard_v"));
      const board = await as(c, "anon", () =>
        rows(
          c,
          `select address, display_name, elo, wins_today, matches_today, wins_7d, matches_7d, win_rate_7d,
                  earned_lamports_7d, wins_all, matches_all, win_rate_all, earned_lamports_all
           from public.leaderboard_v order by address`,
        ),
      );
      const anonName = (a: string) => `anon-${a.slice(-4)}`;
      const expected = [
        {
          address: ROOSTER, display_name: "Rooster", elo: 1032,
          wins_today: 1, matches_today: 2, wins_7d: 1, matches_7d: 3, win_rate_7d: "0.3333", earned_lamports_7d: 1000,
          wins_all: 1, matches_all: 4, win_rate_all: "0.2500", earned_lamports_all: 1500,
        },
        {
          address: HEN, display_name: anonName(HEN), elo: 1000,
          wins_today: 0, matches_today: 1, wins_7d: 1, matches_7d: 2, win_rate_7d: "0.5000", earned_lamports_7d: 0,
          wins_all: 1, matches_all: 2, win_rate_all: "0.5000", earned_lamports_all: 0,
        },
        {
          address: CHICK, display_name: anonName(CHICK), elo: 1000,
          wins_today: 0, matches_today: 1, wins_7d: 0, matches_7d: 1, win_rate_7d: "0.0000", earned_lamports_7d: 0,
          wins_all: 1, matches_all: 2, win_rate_all: "0.5000", earned_lamports_all: 300,
        },
      ];
      expect(board).toEqual(expected.sort((a, b) => (a.address < b.address ? -1 : 1)));
    });
  });

  it("serves pool_v to anon: the latest snapshot and trailing-24h totals", async () => {
    await scratch(async (c) => {
      await addPlayers(c, ROOSTER, HEN);
      const snap = (minutesAgo: number, perWin: number) =>
        c.query(
          `insert into public.pool_snapshots (at, creator_balance_gme, hot_balance, matches_24h, payout_per_win, daily_pool_lamports, market_cap_usd)
           values (date_trunc('minute', now(), 'UTC') - make_interval(mins => $1), 9, 5000000000, 1500, $2, 17600000000, 500000)`,
          [minutesAgo, perWin],
        );
      await snap(2, 1);
      await snap(1, 29000000);
      await snap(3, 2);
      const claim = (ago: string, gme: string, lamports: number) =>
        c.query(
          "insert into public.fee_claims (stage, gme_claimed, player_share_lamports, project_share_gme, at) values ('damm', $1, $2, 1, now() - $3::interval)",
          [gme, lamports, ago],
        );
      await claim("1 hour", "100000000000000000000", 700);
      await claim("23 hours", "5", 70);
      await claim("25 hours", "1000", 7);
      const won = await addMatch(c, { p1: ROOSTER, p2: HEN, winner: ROOSTER });
      await c.query(
        `insert into public.payouts (kind, idem_key, match_id, to_address, lamports, status, tx_sig, paid_at)
         values ('win', $1, $2, $3, 41000000, 'paid', $4, now() - interval '2 hours')`,
        [won, won, ROOSTER, sig("3")],
      );
      await c.query(
        `insert into public.payouts (kind, idem_key, to_address, lamports, status, tx_sig, paid_at)
         values ('daily', '2026-09-20:1', $1, 999, 'paid', $2, now() - interval '3 days')`,
        [HEN, sig("4")],
      );
      await c.query("insert into public.payouts (kind, idem_key, to_address, lamports) values ('daily', '2026-09-22:1', $1, 55)", [HEN]);

      const pool = await as(c, "anon", () => one<Row & { snapshot_at: Date }>(c, "select * from public.pool_v"));
      expect(pool).toMatchObject({
        payout_per_win: 29000000,
        hot_balance: 5000000000,
        daily_pool_lamports: 17600000000,
        matches_24h: 1500,
        claims_24h: 2,
        gme_claimed_24h: "100000000000000000005",
        player_share_lamports_24h: 770,
        project_share_gme_24h: "2",
        paid_count_24h: 1,
        paid_lamports_24h: 41000000,
      });
      const latest = await one<{ at: Date }>(c, "select max(at) as at from public.pool_snapshots");
      expect(pool.snapshot_at).toEqual(latest.at);
    });
  });

  it("indexes the spec's access paths and every foreign key", async () => {
    const idx = (await rows<{ n: string }>(db, "select indexname as n from pg_indexes where schemaname = 'public'")).map((r) => r.n);
    for (const name of [
      "matches_winner_ended_at_idx", // (winner, ended_at desc)
      "matches_p1_p2_ended_at_idx", // (p1, p2, ended_at desc): pairing caps
      "payouts_status_created_at_idx", // (status, created_at): the worker's poll
      "payouts_idem_key_key",
      "leaderboard_v_address_key",
    ]) {
      expect(idx).toContain(name);
    }
    // The same rule as Supabase's unindexed_foreign_keys advisor.
    const unindexed = await rows(
      db,
      `select c.conname from pg_constraint c
       where c.contype = 'f' and c.connamespace = 'public'::regnamespace
         and not exists (
           select 1 from pg_index i
           where i.indrelid = c.conrelid
             and (string_to_array(i.indkey::text, ' ')::int2[])[1:cardinality(c.conkey)] @> c.conkey
             and (string_to_array(i.indkey::text, ' ')::int2[])[1:cardinality(c.conkey)] <@ c.conkey)`,
    );
    expect(unindexed).toEqual([]);
  });

  it("applies the cron migration as a guarded no-op without pg_cron, and re-applies cleanly", async () => {
    expect(notices).toEqual(["NOTICE: pg_cron is not available: leaderboard_v will not refresh on its own"]);
    expect(await rows(db, "select extname from pg_extension where extname = 'pg_cron'")).toEqual([]);
    expect(await rows(db, "select nspname from pg_namespace where nspname = 'cron'")).toEqual([]);
    await scratch(async (c) => {
      const cron = listMigrations().filter((m) => m.name.endsWith("_cron.sql"));
      expect(cron).toHaveLength(1);
      await applyMigrations(c, cron);
      // The job's command runs as the role that schedules it.
      const job = /'(refresh materialized view concurrently public\.leaderboard_v)'/.exec(cron[0]?.sql ?? "");
      expect(job?.[1]).toBeDefined();
      await as(c, "postgres", () => c.exec(job?.[1] ?? ""));
    });
  });
});
