/**
 * PGlite stand-in for the Supabase database, used to test supabase/migrations
 * without Docker or the Supabase CLI.
 *
 * It reproduces the parts of a Supabase project the migrations depend on:
 * - `supabase_admin` is the bootstrap superuser. `postgres` is NOT a superuser
 *   (CREATEROLE CREATEDB REPLICATION BYPASSRLS) and owns the database, and the
 *   migrations run as `postgres`, like `supabase db push`. A migration that
 *   quietly needs superuser rights fails here as it would on Supabase.
 * - The Data API roles: `anon` and `authenticated` (NOLOGIN NOINHERIT) and
 *   `service_role` (NOLOGIN NOINHERIT BYPASSRLS), with USAGE on schema public.
 * - Grant mode. `legacy`: projects created before 2026-05-30 auto-grant ALL on
 *   every new public table, sequence and function to the API roles through
 *   default privileges. `strict`: newer projects grant nothing, so a migration
 *   must grant `service_role` itself.
 *
 * Known gaps: PGlite runs Postgres 18 (Supabase runs 17), ships no pg_cron,
 * and is a single connection, so role changes are session state (see `as`).
 * PGlite quirk: RESET SESSION AUTHORIZATION does not restore the bootstrap
 * user, so the harness only ever uses SET ROLE / RESET ROLE.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite, type PGliteInterface, type QueryOptions } from "@electric-sql/pglite";
import { repoPath } from "../root";

export type GrantMode = "legacy" | "strict";
export const GRANT_MODES: readonly GrantMode[] = ["legacy", "strict"];

export const API_ROLES = ["anon", "authenticated", "service_role"] as const;
export type ApiRole = (typeof API_ROLES)[number];
/** Roles `as()` may switch to. `postgres` is the owner of everything the migrations create. */
export type DbRole = ApiRole | "postgres";
const DB_ROLES: readonly string[] = [...API_ROLES, "postgres"];

/** The session user: the only superuser in the harness. */
export const SUPERUSER = "supabase_admin";

export const MIGRATIONS_DIR = repoPath("supabase", "migrations");
/** The Supabase CLI silently skips files that do not match this pattern. */
export const MIGRATION_FILE = /^(\d{14})_([a-z0-9_]+)\.sql$/;

export interface Migration {
  name: string;
  path: string;
  sql: string;
}

type Notice = Parameters<NonNullable<QueryOptions["onNotice"]>>[0];

/**
 * Migration files in the order the CLI applies them (by version prefix).
 * Throws on any `.sql` file the CLI would skip, and on duplicate versions.
 */
export function listMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const names = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const seen = new Set<string>();
  return names.map((name) => {
    const m = MIGRATION_FILE.exec(name);
    if (!m?.[1]) throw new Error(`${name}: migration files must be named <YYYYMMDDHHMMSS>_<snake_name>.sql`);
    if (seen.has(m[1])) throw new Error(`${name}: duplicate migration version ${m[1]}`);
    seen.add(m[1]);
    const path = join(dir, name);
    return { name, path, sql: readFileSync(path, "utf8") };
  });
}

/**
 * A database with Supabase's roles and grants but no migrations applied.
 * Every call boots a new in-memory PGlite (about a second); use `db.clone()`
 * for cheap copies of an already migrated database.
 */
export async function createCluster(mode: GrantMode): Promise<PGlite> {
  const db = await PGlite.create({ initDbStartParams: [`--username=${SUPERUSER}`], username: SUPERUSER });
  const apiRoles = API_ROLES.join(", ");
  await db.exec(`
    create role postgres login createrole createdb replication bypassrls;
    alter database postgres owner to postgres;
    create role anon nologin noinherit;
    create role authenticated nologin noinherit;
    create role service_role nologin noinherit bypassrls;
    grant anon, authenticated, service_role to postgres;
    grant usage on schema public to ${apiRoles};
  `);
  if (mode === "legacy") {
    for (const owner of ["postgres", SUPERUSER]) {
      await db.exec(`
        alter default privileges for role ${owner} in schema public grant all on tables to ${apiRoles};
        alter default privileges for role ${owner} in schema public grant all on sequences to ${apiRoles};
        alter default privileges for role ${owner} in schema public grant all on functions to ${apiRoles};
      `);
    }
  }
  return db;
}

/**
 * Apply `migrations` in order as `postgres`, each in its own transaction (as
 * the CLI does). A WARNING fails the run: on Postgres it usually means a
 * statement silently did nothing, e.g. "no privileges were granted".
 * Returns every notice raised, for tests that assert on them.
 */
export async function applyMigrations(db: PGliteInterface, migrations: readonly Migration[] = listMigrations()): Promise<Notice[]> {
  const notices: Notice[] = [];
  for (const m of migrations) {
    const warnings: string[] = [];
    const onNotice = (n: Notice) => {
      notices.push(n);
      if (n.severity === "WARNING") warnings.push(n.message ?? "");
    };
    await as(db, "postgres", async () => {
      try {
        await db.exec(`begin;\n${m.sql}\n;commit;`, { onNotice });
      } catch (e) {
        await db.exec("rollback");
        throw new Error(`${m.name}: ${(e as Error).message}`, { cause: e });
      }
    });
    if (warnings.length) throw new Error(`${m.name} raised WARNING: ${warnings.join("; ")}`);
  }
  return notices;
}

/** A fresh Supabase-like database with every migration in supabase/migrations applied. */
export async function freshDb(mode: GrantMode): Promise<PGlite> {
  const db = await createCluster(mode);
  try {
    await applyMigrations(db);
  } catch (e) {
    await db.close();
    throw e;
  }
  return db;
}

/**
 * Run `fn` with the session's current role set to `role` (SET ROLE), then
 * restore whatever role was active before, even if `fn` throws. Nests.
 * PGlite is one connection: do not run other queries on `db` concurrently
 * with `fn`, or they execute as `role` too.
 */
export async function as<T>(db: PGliteInterface, role: DbRole, fn: () => Promise<T>): Promise<T> {
  if (!DB_ROLES.includes(role)) throw new Error(`as(): unknown role ${JSON.stringify(role)}`);
  const prev = await db.query<{ role: string; session: string }>("select current_user as role, session_user as session");
  const { role: prevRole, session } = prev.rows[0] ?? { role: SUPERUSER, session: SUPERUSER };
  await db.exec(`set role ${role}`);
  try {
    return await fn();
  } finally {
    // prevRole comes from the catalog, never from the caller.
    await db.exec(prevRole === session ? "reset role" : `set role "${prevRole.replaceAll('"', '""')}"`);
  }
}
