import type { PGlite, PGliteInterface } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SUPERUSER, as, createCluster } from "../src/db/harness";

const BOOT_MS = 60_000;

type Row = Record<string, unknown>;

async function rows<T = Row>(db: PGliteInterface, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

async function one<T = Row>(db: PGliteInterface, sql: string, params: unknown[] = []): Promise<T> {
  const r = await rows<T>(db, sql, params);
  if (r.length !== 1) throw new Error(`expected one row, got ${r.length}: ${sql}`);
  return r[0] as T;
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
