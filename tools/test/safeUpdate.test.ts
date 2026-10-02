/**
 * Supabase runs pg-safeupdate: an UPDATE or DELETE without a WHERE clause is
 * refused at run time ("UPDATE requires a WHERE clause"). PGlite, which the
 * SQL tests run on, has no such check, so a bare UPDATE passes every test and
 * then fails in production (it did: record_match, 2026-10-02). This reads the
 * migrations in order, keeps the latest definition of every function, and
 * fails on any bare UPDATE / DELETE in them. (Upserts, `on conflict do
 * update set`, are not plain UPDATEs and are fine.)
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = resolve(import.meta.dirname, "../../supabase/migrations");

function latestFunctions(): Map<string, { file: string; body: string }> {
  const fns = new Map<string, { file: string; body: string }>();
  for (const file of readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(DIR, file), "utf8");
    const re = /create\s+(?:or\s+replace\s+)?function\s+public\.(\w+)\s*\(([\s\S]*?)\$\$([\s\S]*?)\$\$\s*;/gi;
    for (const m of sql.matchAll(re)) fns.set(m[1] as string, { file, body: m[3] as string });
  }
  return fns;
}

/** Plain UPDATE … SET … / DELETE FROM … statements with no WHERE before their `;`. */
function bareWrites(body: string): string[] {
  const out: string[] = [];
  const re = /\b(update\s+(?:only\s+)?(?:public\.)?\w+(?:\s+(?:as\s+)?\w+)?\s+set\b|delete\s+from\b)[^;]*;/gi;
  // `on conflict … do update set` never matches: it has no table name between UPDATE and SET.
  for (const m of body.matchAll(re)) {
    if (!/\bwhere\b/i.test(m[0])) out.push(m[0].replace(/\s+/g, " ").trim());
  }
  return out;
}

describe("pg-safeupdate (Supabase refuses UPDATE / DELETE without WHERE)", () => {
  it("catches a bare update and lets upserts and WHERE'd updates through", () => {
    expect(bareWrites("update public.pool_state ps set win_available = 1;")).toHaveLength(1);
    expect(bareWrites("update public.pool_state ps set win_available = 1 where ps.id;")).toEqual([]);
    expect(bareWrites("insert into public.players (a) values (1) on conflict (a) do update set last_seen = now();")).toEqual([]);
    expect(bareWrites("delete from public.settings;")).toHaveLength(1);
  });

  it("no function's current definition has a bare UPDATE or DELETE", () => {
    const fns = latestFunctions();
    expect(fns.has("record_match")).toBe(true);
    const bad = [...fns].flatMap(([name, f]) => bareWrites(f.body).map((s) => `${name} (${f.file}): ${s.slice(0, 100)}`));
    expect(bad).toEqual([]);
  });
});
