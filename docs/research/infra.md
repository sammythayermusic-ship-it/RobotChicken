# COCKFIGHT Phase 0 infra plan: Supabase, game server, Docker, Fly, Vercel, env and shared packages

Everything below was checked against the npm registry, the published package sources on jsDelivr, and vendor docs. Plan mode stopped me from installing anything, so the PGlite checks were not run on this machine. The first job of the session should be to run that test suite.

## Versions and cross-cutting decisions

- **pnpm:** pin `"packageManager": "pnpm@11.0.9"` to match the machine. Three pnpm 11 defaults affect this project:
  - `strictDepBuilds: true`. Install fails until you list the packages allowed to run build scripts under `allowBuilds` in `pnpm-workspace.yaml`. Expect `esbuild` and `sharp`, probably `unrs-resolver`, and `msgpackr-extract: false`. Copy the exact names from the first install's error.
  - `minimumReleaseAge: 1440`. pnpm won't resolve anything published less than a day ago. Most of Colyseus was republished today, so set lower bounds that are at least a day old.
  - `.npmrc` now only holds auth and registry settings. Everything else goes in `pnpm-workspace.yaml`.
- **Colyseus:** use `@colyseus/core ~0.18.15`, `@colyseus/ws-transport ~0.18.2`, `@colyseus/schema ^5.0.33`, plus `express ^5.2.1`. Dev-only: `@colyseus/testing ~0.18.5`, `@colyseus/sdk ~0.18.3`, `@colyseus/tools ~0.18.3`.
  - This departs from the spec's 0.16, which is two majors old. It isn't a locked decision; record it in the README.
  - 0.18 has built-in pieces that match the spec's netcode: `setFixedTimestep(cb, 60)` (a fixed-step accumulator), `defineInput` (buffered inputs, de-duplicated by sequence number, with a per-client ack), `onDrop`/`onReconnect`, a built-in `QueueRoom`, and `COLYSEUS_LATENCY` for simulating lag.
  - The client library is now `@colyseus/sdk`; `colyseus.js` is legacy.
- **Other pins:**
  - `zod ^4.6` (Colyseus core expects zod ^4.1.12 as a peer).
  - `@electric-sql/pglite ^0.5.8`. It runs Postgres 18, while Supabase runs 17, so avoid `uuidv7()` and virtual generated columns.
  - `tsx ^4.23`, `esbuild ^0.28`, `vitest ~4.1.11` (proven in soltendogs; 5.0 just shipped), `smol-toml ^1.9`, `bs58 ^6`.
  - Next `~16.3.5` rather than the spec's 15, matching the sibling project.
- **TypeScript:** pin `~5.9.3`. `typescript-eslint` only supports TypeScript below 6.1, so TypeScript 7.0.2 would break linting even though Next 16.3 accepts it.
- **Internal packages have no build step.** Each exports source directly (`"exports": {".": "./src/index.ts"}`). tsx, vitest, esbuild and Next's `transpilePackages` all read TypeScript source.
- **Dependency direction:** `sim` depends on nothing, `shared` depends on `sim` (for the button bitmask), and `game`/`web`/`worker` depend on both. `solana` depends on nothing except `bs58`.

## (a) Supabase

**Layout.** Hand-write these files; the Supabase CLI isn't installed.
- `supabase/config.toml`: `project_id="cockfight"`, `[api] schemas=["public","graphql_public"]`, `[db] major_version=17`, `[db.seed] enabled=false`.
- `supabase/migrations/20260923000000_init.sql`
- `supabase/migrations/20260923000100_cron.sql`

Pushing later works without Docker: `pnpm dlx supabase@2.117.0 link --project-ref … && … db push`.

**Two Supabase changes that affect new projects:**
1. Projects created after 2026-05-30 no longer give `anon`, `authenticated` or `service_role` automatic grants on new tables. The migration must grant to `service_role` explicitly, or the game and worker can't write.
2. New projects no longer get the legacy JWT keys. Keep the spec's variable names, but the values will be `sb_publishable_…` (the "anon key") and `sb_secret_…` (the "service role key"). The Postgres roles are unchanged.

```sql
-- 20260923000000_init.sql  (PG17-safe; enums are text+check so zod mirrors them and ALTER is trivial)
create table public.players (
  address text primary key check (address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  username text check (username ~ '^[A-Za-z0-9_]{3,16}$'), username_sig text,
  elo integer not null default 1000 check (elo between 0 and 4000),
  tier text not null default 'rust' check (tier in ('rust','chrome','gold','diamond')),
  first_seen timestamptz not null default now(), last_seen timestamptz not null default now(),
  flags jsonb not null default '{}' check (jsonb_typeof(flags)='object'));
create unique index players_username_ci on public.players (lower(username)) where username is not null;

create table public.balance_checks (           -- no FK: audit inserts must never fail
  id bigint generated always as identity primary key, address text not null,
  usd numeric(14,4) not null, tokens numeric(30,9) not null,
  source text not null check (source in ('jupiter','curve')),
  checked_at timestamptz not null default now());
create index balance_checks_addr_idx on public.balance_checks (address, checked_at desc);

create table public.matches (
  id uuid primary key default gen_random_uuid(),
  p1 text not null references public.players, p2 text not null references public.players,
  region text not null check (region ~ '^[a-z]{3}$'),
  started_at timestamptz not null default now(), ended_at timestamptz,
  winner text references public.players,
  reason text check (reason in ('ko','ringout','timeout','forfeit')),
  rounds jsonb not null default '[]' check (jsonb_typeof(rounds)='array'),
  input_log bytea check (octet_length(input_log) <= 262144),
  result_hash text check (result_hash ~ '^[0-9a-f]{64}$'),
  net_quality_p1 real check (net_quality_p1 between 0 and 1),
  net_quality_p2 real check (net_quality_p2 between 0 and 1),
  payout_lamports bigint not null default 0 check (payout_lamports >= 0), flag text,
  check (p1 <> p2), check (winner is null or winner in (p1,p2)),
  check ((ended_at is null) = (reason is null)));
create index matches_winner_ended_idx on public.matches (winner, ended_at desc);
create index matches_pair_ended_idx   on public.matches (p1, p2, ended_at desc);
create index matches_p2_ended_idx     on public.matches (p2, ended_at desc);   -- profile history

create table public.payouts (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('win','daily')),
  idem_key text not null unique, match_id uuid references public.matches,
  to_address text not null, lamports bigint not null check (lamports >= 0),
  status text not null default 'pending'
    check (status in ('pending','sent','paid','deferred','failed','voided')),
  tx_sig text unique, attempts integer not null default 0,
  last_error text, next_attempt_at timestamptz,            -- added: worker backoff
  created_at timestamptz not null default now(), paid_at timestamptz,
  check ((kind='win' and match_id is not null and idem_key = match_id::text)
      or (kind='daily' and match_id is null and idem_key ~ '^\d{4}-\d{2}-\d{2}:([1-9]|10)$')),
  check (status <> 'paid' or (tx_sig is not null and paid_at is not null)));
create index payouts_status_created_idx on public.payouts (status, created_at);
create index payouts_paid_idx on public.payouts (paid_at desc) where status = 'paid';

create table public.daily_rewards (
  day date not null, rank smallint not null check (rank between 1 and 10),
  address text not null, wins integer not null, elo integer not null,
  pool_lamports bigint not null, share_bps integer not null check (share_bps between 0 and 10000),
  lamports bigint not null, payout_id bigint references public.payouts,
  primary key (day, rank), unique (day, address));

create table public.fee_claims (               -- token amounts in raw base units
  id bigint generated always as identity primary key,
  stage text not null check (stage in ('dbc','damm')),
  gme_claimed numeric(40,0) not null default 0, cock_claimed numeric(40,0) not null default 0,
  sol_after_swap bigint, player_share_lamports bigint, project_share_gme numeric(40,0),
  claim_sig text, swap_sig text, at timestamptz not null default now());
create index fee_claims_at_idx on public.fee_claims (at desc);

create table public.pool_snapshots (
  at timestamptz primary key,                  -- worker writes date_trunc('minute', now()); upsert
  creator_balance_gme numeric(40,0) not null, hot_balance bigint not null,
  matches_24h integer not null, payout_per_win bigint not null,
  daily_pool_lamports bigint not null, market_cap_usd numeric(20,2));

create table public.abuse_events (
  id bigint generated always as identity primary key,
  address text, fingerprint text, ip_hash text,
  kind text not null check (kind ~ '^[a-z_]{2,32}$'),
  match_id uuid references public.matches, details jsonb not null default '{}',
  created_at timestamptz not null default now(), resolved_by text, resolved_at timestamptz);
create index abuse_open_idx on public.abuse_events (created_at desc) where resolved_by is null;

alter table public.players enable row level security;        -- repeat for all 8 tables; no policies

create materialized view public.leaderboard_v as
with b as (select date_trunc('day', now() at time zone 'utc') at time zone 'utc' as today),
side as (select p1 as address, winner = p1 as won, ended_at from public.matches where ended_at is not null
         union all select p2, winner = p2, ended_at from public.matches where ended_at is not null),
agg as (select address,
  count(*) filter (where ended_at >= b.today) matches_today,
  count(*) filter (where won and ended_at >= b.today) wins_today,
  count(*) filter (where ended_at >= now()-interval '7 days') matches_7d,
  count(*) filter (where won and ended_at >= now()-interval '7 days') wins_7d,
  count(*) matches_all, count(*) filter (where won) wins_all
  from side cross join b group by address),
earned as (select to_address as address,
  sum(lamports) filter (where paid_at >= now()-interval '7 days') l7, sum(lamports) lall
  from public.payouts where status='paid' group by to_address)
select a.*, p.elo, p.tier, coalesce(p.username, 'anon-'||right(a.address,4)) display_name,
  round(a.wins_7d::numeric/nullif(a.matches_7d,0),4) win_rate_7d,
  round(a.wins_all::numeric/nullif(a.matches_all,0),4) win_rate_all,
  coalesce(e.l7,0) lamports_7d, coalesce(e.lall,0) lamports_all, now() refreshed_at
from agg a join public.players p using (address) left join earned e using (address);
create unique index leaderboard_v_addr_uq on public.leaderboard_v (address);  -- required for CONCURRENTLY

create view public.pool_v as   -- owner-rights view on purpose: anon sees aggregates only
select s.at, s.creator_balance_gme, s.hot_balance, s.matches_24h, s.payout_per_win,
       s.daily_pool_lamports, s.market_cap_usd, f.*, p.*
from (select 1) one
left join lateral (select * from public.pool_snapshots order by at desc limit 1) s on true
cross join lateral (select coalesce(sum(gme_claimed),0) gme_claimed_24h, coalesce(sum(sol_after_swap),0) sol_after_swap_24h,
  coalesce(sum(player_share_lamports),0) player_share_lamports_24h, coalesce(sum(project_share_gme),0) project_share_gme_24h
  from public.fee_claims where at > now()-interval '24 hours') f
cross join lateral (select coalesce(sum(lamports),0) paid_lamports_24h, count(*) paid_count_24h
  from public.payouts where status='paid' and paid_at > now()-interval '24 hours') p;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
grant select on public.leaderboard_v, public.pool_v to anon, authenticated;
```

```sql
-- 20260923000100_cron.sql  (no-op where pg_cron is unavailable, e.g. PGlite)
do $$ begin
  if exists (select 1 from pg_available_extensions where name='pg_cron') then
    create extension if not exists pg_cron with schema pg_catalog;
    grant usage on schema cron to postgres; grant all on all tables in schema cron to postgres;
    perform cron.schedule('refresh_leaderboard_v','* * * * *','refresh materialized view concurrently public.leaderboard_v');
    perform cron.schedule('purge_cron_history','17 3 * * *',
      $c$delete from cron.job_run_details where end_time < now() - interval '3 days'$c$);
  end if; end $$;
```

The purge job is there because `job_run_details` grows by 1,440 rows a day. `cron.schedule` with an existing job name replaces that job, so re-running the migration is safe.

The Supabase security advisor will raise three warnings that are all intentional. Document them in the README:
- `security_definer_view` on `pool_v`
- `materialized_view_in_api` on `leaderboard_v`
- eight `rls_enabled_no_policy` notices

Later phases will need two more public views:
- `/m/[id]` needs a public view of matches that includes `input_log`, because anon can't read the base table.
- The payout ticker needs `recent_payouts_v`.

Supabase Realtime can't push `pool_snapshots` changes to anon clients, so the front page should poll `pool_v`.

**PGlite harness** (`tools/src/db/harness.ts`, exported for the Phase 3 idempotency tests)
- PGlite 0.5 ships no pg_cron.
- It doesn't need pgcrypto, because `gen_random_uuid()` is built into Postgres 13 and later.
- Materialized views and `SET ROLE` with RLS work there.
- The harness must create the `anon`, `authenticated` and `service_role` roles itself.

```ts
import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
const DIR = new URL('../../../supabase/migrations/', import.meta.url);
export async function freshDb(mode: 'legacy' | 'strict') {       // legacy = pre-May-2026 auto-grants
  const db = await PGlite.create();
  await db.exec(`create role anon nologin; create role authenticated nologin;
    create role service_role nologin bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    ${mode === 'legacy' ? `alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;` : ''}`);
  for (const f of readdirSync(DIR).filter(f => f.endsWith('.sql')).sort())
    await db.exec(readFileSync(new URL(f, DIR), 'utf8'));
  return db;
}
export async function as<T>(db: PGlite, role: string, fn: () => Promise<T>) {
  await db.exec(`set role ${role}`); try { return await fn(); } finally { await db.exec('reset role'); }
}
```

Tests in `tools/test/migrations.test.ts`, run under `describe.each(['legacy','strict'])` with one database per file in `beforeAll`:
1. The set of tables in `pg_class` (relkind `r`) equals the 8 expected tables, and `relrowsecurity` is true for all of them. `pg_policies` has 0 rows in `public`.
2. For every table: `has_table_privilege('anon'|'authenticated', t, 'select'|'insert'|'update'|'delete')` is false, and `service_role` has select and insert.
3. As `anon`: `select 1 from public.payouts` fails with /permission denied/. `pool_v` returns exactly one row, which is all nulls or zeros when the database is empty. `leaderboard_v` is readable.
4. As `service_role`: insert a player, a match and a win payout. A duplicate `idem_key` fails with code `23505`, and a malformed daily key fails with `23514`.
5. `refresh materialized view concurrently` succeeds and `wins_today` counts correctly.
6. All index names are present in `pg_indexes`.
7. `pg_extension` has no `pg_cron` row, which proves the guard.
8. A `toMatchSnapshot()` of `information_schema.columns`, to catch drift from the hand-written zod row types in `shared`. `supabase gen types` would need Docker.

## (b) apps/game skeleton

```ts
// src/app.config.ts
import http from 'node:http';
import { defineServer, defineRoom } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { loadGameEnv } from '@cockfight/shared/env';
import { LobbyRoom } from './rooms/LobbyRoom';   // not core's LobbyRoom (name clash)
import { FightRoom } from './rooms/FightRoom';
export const env = loadGameEnv(process.env);
export default defineServer({
  greet: false,
  // explicit: the bundled server has no node_modules for core's dynamicImport fallback
  transport: new WebSocketTransport({ server: http.createServer() }),
  rooms: { lobby: defineRoom(LobbyRoom), fight: defineRoom(FightRoom) },
  express: (app) => { app.get('/health', (_q, r) => { r.json({ ok: true, region: env.FLY_REGION }); }); },
});
// src/index.ts
import server, { env } from './app.config';
await server.listen(env.PORT, '0.0.0.0');                 // Fly needs 0.0.0.0, not localhost
```

```ts
// src/state.ts — Colyseus schema() style: no decorators, no useDefineForClassFields hacks
import { schema, t, type SchemaType } from '@colyseus/schema';
export const Fighter = schema({ x: t.int32(), y: t.int32(), vx: t.int32(), vy: t.int32(),
  hp: t.uint32(), heat: t.uint32(), state: t.uint8(), stateTick: t.uint16(), facing: t.int8(),
  roundWins: t.uint8(), lastAck: t.uint32() }, 'Fighter');
export const FightState = schema({ tick: t.uint32(), phase: t.uint8(), round: t.uint8(),
  roundTimer: t.uint16(), p1: Fighter, p2: Fighter }, 'FightState');
export type FightState = SchemaType<typeof FightState>;

// src/rooms/FightRoom.ts
import { Room, validate, type Client } from '@colyseus/core';
import { initState, step, TICK_RATE } from '@cockfight/sim';
import { InputMsg, SNAPSHOT_HZ } from '@cockfight/shared';
export class FightRoom extends Room<{ state: FightState }> {
  maxClients = 2; state = new FightState();
  #sim = initState({ seed: 1 }); #btn: [number, number] = [0, 0]; #slot = new Map<string, 0 | 1>();
  messages = { input: validate(InputMsg, (c: Client, m) => { const s = this.#slot.get(c.sessionId); if (s !== undefined) this.#btn[s] = m.b; }) };
  onCreate() { this.setPatchRate(1000 / SNAPSHOT_HZ);
    this.setFixedTimestep(() => { this.#sim = step(this.#sim, this.#btn[0], this.#btn[1]); writeSnapshot(this.state, this.#sim); }, TICK_RATE); }
  onJoin(c: Client) { this.#slot.set(c.sessionId, this.#slot.size as 0 | 1); }
  // Phase 2: onDrop → pause + await this.allowReconnection(c, 10) → catch = forfeit; onReconnect → resume
}
```

- **Room lifecycle in 0.18:** `onCreate` → `onAuth` → `onJoin` → `messages` → `onDrop` (a non-consented disconnect; call `allowReconnection` here) → `onReconnect` / `onLeave` → `onDispose`. `onBeforeShutdown` runs on shutdown; override it in Phase 2 so a live match can finish (under 300 s).
- **CORS:** it's open to any origin by default. Restrict it in Phase 2 with `matchMaker.controller.getCorsHeaders`.
- **Scripts:**
  - `dev`: `tsx watch --clear-screen=false src/index.ts`. tsx also watches `packages/*` source, because symlinks resolve outside `node_modules`.
  - `build`: `node build.mjs`, which runs esbuild with `bundle:true, platform:'node', target:'node22', format:'esm', outfile:'dist/server.mjs', sourcemap:'linked'`. Mark `bufferutil`, `utf-8-validate`, `msgpackr-extract`, `@colyseus/bun-websockets`, `@colyseus/uwebsockets-transport` and `@pm2/io` as external. Add the banner ``import{createRequire as r}from'node:module';const require=r(import.meta.url);`` so bundled CommonJS code (express) can call `require`.
  - `smoke`: copy `dist/` to `os.tmpdir()`, which proves no `node_modules` is needed. Spawn node there, poll `/health`, `POST /matchmake/joinOrCreate/lobby`, and assert a 200 response containing `sessionId`.
- **Tests:** vitest with `@colyseus/testing`: `boot(server)`, `createRoom('fight')`, connect two clients, `send('input', …)`, `await room.waitForNextSimulationTick()`, then assert `state.tick > 0`.
- **Skip `@colyseus/tools` at runtime.** Its env loader pulls in `@pm2/io` and reads `.env` and `/etc/environment` as a side effect. It's only needed as a dev dependency because `@colyseus/testing` expects it as a peer.
- **Root `dev` script:** `pnpm --parallel --filter @cockfight/web --filter @cockfight/game run dev`. Web runs on :3000, game on :2567.

## (c) Dockerfile and fly.toml

Use a single-file bundle rather than `pnpm deploy`. On 11.0.9, `pnpm deploy` needs `injectWorkspacePackages: true`. That setting copies workspace packages instead of symlinking them, which breaks live-editing `packages/sim` in dev. Versions 11.19 to 11.25 also had a deploy regression.

```dockerfile
# apps/game/Dockerfile  (build context = repo root; worker Dockerfile identical s/game/worker/, port 8080)
# syntax=docker/dockerfile:1.7
FROM node:22.22.2-bookworm-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile --filter "@cockfight/game..." \
 && pnpm --filter @cockfight/game build
FROM node:22.22.2-bookworm-slim
ENV NODE_ENV=production PORT=2567
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/game/dist ./
USER node
EXPOSE 2567
CMD ["node","--enable-source-maps","server.mjs"]
```

The root `.dockerignore` should exclude `**/node_modules`, `**/.next`, `**/dist`, `.git`, `art`, `coverage`, `.env*`, and `apps/web/*` with the exception `!apps/web/package.json`. Keeping every workspace `package.json` keeps the frozen lockfile consistent. `esbuild` must be a dev dependency of `apps/game` itself, because a filtered install skips the root's dev dependencies.

```toml
# apps/game/fly.toml
app = "cockfight-game"
primary_region = "iad"          # fra added via scaling; fly.toml can't list secondary regions
kill_signal = "SIGTERM"         # Colyseus handles SIGINT/SIGTERM/SIGUSR2
kill_timeout = 300              # max; lets a live match finish (Phase 2 onBeforeShutdown)
[env]
  NODE_ENV = "production"
  PORT = "2567"
[http_service]
  internal_port = 2567
  force_https = true
  auto_stop_machines = "off"
  auto_start_machines = false
  min_machines_running = 1
  [http_service.concurrency]
    type = "connections"
    soft_limit = 400
    hard_limit = 500
  [[http_service.checks]]
    type = "http"
    method = "GET"
    path = "/health"
    interval = "15s"
    timeout = "2s"
    grace_period = "10s"
[[vm]]
  size = "shared-cpu-1x"
  memory = "1gb"
```

```toml
# apps/worker/fly.toml — no public service, single machine
app = "cockfight-worker"
primary_region = "iad"
kill_signal = "SIGTERM"
kill_timeout = 60
[env]
  NODE_ENV = "production"
  PORT = "8080"
[checks.alive]
  type = "http"
  port = 8080
  path = "/health"
  interval = "30s"
  timeout = "5s"
  grace_period = "10s"
[[vm]]
  size = "shared-cpu-1x"
  memory = "512mb"
```

- **Deploy commands** (as root scripts, run from the repo root):
  - `fly deploy . -c apps/game/fly.toml --dockerfile apps/game/Dockerfile`, then `fly scale count 1 --region fra -c apps/game/fly.toml`. Run one region per command, because the docs don't say whether a multi-region count is per region or total.
  - `fly deploy . -c apps/worker/fly.toml --dockerfile apps/worker/Dockerfile --ha=false`. Without `--ha=false` Fly adds a spare machine, and there must be exactly one signer.
- **Local verification** (no Docker):
  - `pnpm --filter @cockfight/game build && pnpm --filter @cockfight/game smoke`. This mirrors the runtime image exactly.
  - `tools/test/infra.test.ts` parses both `fly.toml` files with smol-toml and asserts the port, `auto_stop_machines="off"`, the `/health` check path, the VM size, and that the worker has no `http_service`.
- **CI** (`.github/workflows/ci.yml`; runners have Docker):
  - Actions: `actions/checkout@v7`, `pnpm/action-setup@v6` (reads `packageManager`), `actions/setup-node@v7` with node 22.22.2 and pnpm cache. Then install, typecheck and test.
  - A docker job runs `docker build -f apps/game/Dockerfile .` and `docker run -p 2567:2567`, then curls `/health` in a retry loop.
  - The sim's golden-hash replay test on CI (Linux x64) plus the Mac (arm64) covers the "identical hash on two machines" criterion.
- **Phase 2 flag:** the anycast `fly.dev` hostname routes each request to the nearest machine, so a WebSocket can land on a machine that doesn't hold the room. Decide between replying with `fly-replay` from the WebSocket upgrade handler and running one Fly app per region. Also, `UPSTASH_REDIS_URL` in the spec is the REST endpoint, but the Colyseus Redis driver needs a TCP `rediss://` URL.

## (d) Vercel

- **Project settings:** Root Directory `apps/web`, Framework Next.js, Node 22.x. "Include files outside root" stays at its default (on).
- **Set `ENABLE_EXPERIMENTAL_COREPACK=1`.** Without it Vercel maps lockfile v9 to pnpm 9 or 10, which can't read the pnpm 11 `pnpm-workspace.yaml` and fails with "packages field missing".
- **`apps/web/vercel.json`** (it must live in the Root Directory):

```json
{ "$schema": "https://openapi.vercel.sh/vercel.json", "framework": "nextjs", "regions": ["iad1"],
  "installCommand": "pnpm install --frozen-lockfile --filter @cockfight/web...",
  "ignoreCommand": "git diff --quiet ${VERCEL_GIT_PREVIOUS_SHA:-HEAD^} HEAD -- . ../../packages ../../pnpm-lock.yaml ../../pnpm-workspace.yaml ../../package.json" }
```

  - The filtered install skips Colyseus and the root dev dependencies, so `apps/web` must list its own `typescript`.
  - `ignoreCommand` exits 0 to skip a build. If the git diff errors (for example the previous SHA isn't in the shallow clone), the build runs anyway.
- **`next.config.ts`:** `transpilePackages: ['@cockfight/sim','@cockfight/shared','@cockfight/solana']`, `devIndicators: false`.
  - Leave `turbopack.root` unset. Next finds the repo root from `pnpm-lock.yaml`, and I checked that `~` has no stray lockfiles.
  - Don't copy soltendogs' `immutable` Cache-Control rule for `/models/*` unless filenames are content-hashed. Otherwise an updated glb stays cached for a year.
  - `next dev` writes an `AGENTS.md` block into the app; commit it.

## (e) Env: `.env.example` and the zod schema

```bash
# --- web: public (inlined at build; read via literal process.env.NEXT_PUBLIC_X only) ---
NEXT_PUBLIC_GAME_WS_URL=ws://localhost:2567   # web; prod wss://cockfight-game.fly.dev
NEXT_PUBLIC_COCK_MINT=                        # web, game, worker; set at launch
NEXT_PUBLIC_TURNSTILE_SITE_KEY=               # web; dev default = CF always-pass 1x00000000000000000000AA
NEXT_PUBLIC_SUPABASE_URL=                     # web; public views only
NEXT_PUBLIC_SUPABASE_ANON_KEY=                # web; sb_publishable_… on new projects
# --- web: server ---
TURNSTILE_SECRET_KEY=                         # web; dev default 1x0000000000000000000000000000000AA
HELIUS_API_KEY=                               # web API routes, worker
JUPITER_PRICE_URL=https://api.jup.ag/price/v3 # web; spec's /price/v2 is deprecated
JUPITER_API_KEY=                              # web, worker; ADDED (v3 requires x-api-key)
GATE_USD_MIN=30                               # web, game
QUEUE_JWT_SECRET=                             # web, game; >=32 chars; dev fallback, required in prod
QUOTE_MINT=                                   # web, worker; GME mint (verify on-chain)
ADMIN_USER=                                   # web /admin
ADMIN_PASS=
ADMIN_IP_ALLOWLIST=                           # comma-separated
# --- shared server ---
SOLANA_CLUSTER=devnet                         # all; mainnet-beta at launch
SUPABASE_URL=                                 # game, worker
SUPABASE_SERVICE_ROLE_KEY=                    # game, worker; sb_secret_…; never in browser
UPSTASH_REDIS_URL=                            # web, game, worker (REST)
UPSTASH_REDIS_TOKEN=
REDIS_URL=                                    # game; ADDED Phase 2: rediss:// TCP for Colyseus driver
TELEGRAM_BOT_TOKEN=                           # worker, game
TELEGRAM_CHAT_ID=
# --- game ---
PORT=2567
ALLOWED_ORIGINS=http://localhost:3000         # ADDED: matchmake CORS
COLYSEUS_LATENCY=                             # dev only; built-in lag simulation (ms RTT)
# --- worker ---
CREATOR_WALLET_KEYPAIR=                       # Fly secret only (base58 secret key)
HOT_WALLET_KEYPAIR=                           # Fly secret only
MAX_PAYOUT_LAMPORTS=500000000
MAX_HOURLY_LAMPORTS=20000000000
PAYOUT_P_MIN=0.005                            # SOL, parsed exactly to lamports
PAYOUT_P_MAX=0.5
PAYOUT_M_FLOOR=200
PLAYER_SHARE_BPS=7000
DAILY_POOL_BPS=2000                           # per-win = PLAYER_SHARE_BPS - DAILY_POOL_BPS
PAYOUT_CURRENCY=SOL                           # SOL | GME
DBC_POOL=
DAMM_POOL=
PAYOUTS_ENABLED=false                         # ADDED: global kill switch
```

`FLY_REGION` and `FLY_IMAGE_REF` are set by Fly and default to `local`.

```ts
// packages/shared/src/env.ts
import { z } from 'zod';
export const clean = (s: Record<string, string | undefined>) =>   // "FOO=" must hit .default(), not 0/""
  Object.fromEntries(Object.entries(s).flatMap(([k, v]) => (v?.trim() ? [[k, v.trim()]] : [])));
const b58 = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const lamports = (d: bigint) => z.string().regex(/^\d+$/).transform(BigInt).default(d);
const sol = (d: string) => z.string().regex(/^\d+(\.\d{1,9})?$/).default(d).transform(solToLamports);
const bps = (d: number) => z.coerce.number().int().min(0).max(10_000).default(d);
const common = { NODE_ENV: z.enum(['development','test','production']).default('development'),
  SOLANA_CLUSTER: z.enum(['devnet','mainnet-beta','localnet']).default('devnet'),
  NEXT_PUBLIC_COCK_MINT: b58.optional(), SUPABASE_URL: z.url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(), UPSTASH_REDIS_URL: z.url().optional(),
  UPSTASH_REDIS_TOKEN: z.string().optional(), TELEGRAM_BOT_TOKEN: z.string().optional(), TELEGRAM_CHAT_ID: z.string().optional() };
export const gameEnv = z.object({ ...common, PORT: z.coerce.number().int().default(2567),
  FLY_REGION: z.string().default('local'), GATE_USD_MIN: z.coerce.number().positive().default(30),
  QUEUE_JWT_SECRET: z.string().min(32).optional(), REDIS_URL: z.url().optional(),
  ALLOWED_ORIGINS: z.string().default('http://localhost:3000').transform(s => s.split(',')) });
export const workerEnv = z.object({ ...common, PORT: z.coerce.number().int().default(8080),
  MAX_PAYOUT_LAMPORTS: lamports(500_000_000n), MAX_HOURLY_LAMPORTS: lamports(20_000_000_000n),
  PAYOUT_P_MIN: sol('0.005'), PAYOUT_P_MAX: sol('0.5'), PAYOUT_M_FLOOR: z.coerce.number().int().default(200),
  PLAYER_SHARE_BPS: bps(7000), DAILY_POOL_BPS: bps(2000), PAYOUT_CURRENCY: z.enum(['SOL','GME']).default('SOL'),
  PAYOUTS_ENABLED: z.stringbool().default(false),            // never z.coerce.boolean(): "false" → true
  CREATOR_WALLET_KEYPAIR: z.string().optional(), HOT_WALLET_KEYPAIR: z.string().optional(),
  DBC_POOL: b58.optional(), DAMM_POOL: b58.optional(), QUOTE_MINT: b58.optional(), HELIUS_API_KEY: z.string().optional() })
  .refine(e => e.DAILY_POOL_BPS <= e.PLAYER_SHARE_BPS, 'DAILY_POOL_BPS > PLAYER_SHARE_BPS');
export const webPublicEnv = z.object({ NEXT_PUBLIC_GAME_WS_URL: z.url().default('ws://localhost:2567'),
  NEXT_PUBLIC_COCK_MINT: b58.optional(), NEXT_PUBLIC_TURNSTILE_SITE_KEY: z.string().default('1x00000000000000000000AA'),
  NEXT_PUBLIC_SUPABASE_URL: z.url().optional(), NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().optional() });
// webServerEnv follows the same pattern
export const loadGameEnv = (e: NodeJS.ProcessEnv) => gameEnv.parse(clean(e));   // + loadWorkerEnv, loadWebServerEnv
/** Called at a feature's entry point, not at boot, so a zero-secret deploy still boots. */
export function requireIn(prod: boolean, e: object, keys: string[]) { /* throw listing missing keys; also reject Turnstile test keys in prod */ }
```

On the client, parse from literal references in `apps/web/src/env.public.ts`, e.g. `webPublicEnv.parse(clean({ NEXT_PUBLIC_GAME_WS_URL: process.env.NEXT_PUBLIC_GAME_WS_URL, … }))`. Next doesn't inline dynamic `process.env[k]` lookups; soltendogs' `env(k)` helper relies on them and would come back empty in the browser.

## (f) Shared schemas and the Solana stub

```ts
// packages/shared/src/net.ts
import { BUTTON_MASK } from '@cockfight/sim';        // BTN = {L:1,R:2,U:4,D:8,A:16}; mask 31
export const InputMsg = z.strictObject({ t: z.uint32(), b: z.int().min(0).max(BUTTON_MASK) });
export const PHASES = ['waiting','countdown','fighting','roundEnd','matchEnd'] as const; // schema stores index
const Fighter = z.object({ x: z.int32(), y: z.int32(), vx: z.int32(), vy: z.int32(), hp: z.int().min(0),
  heat: z.int().min(0), state: z.int().min(0).max(255), stateTick: z.int().min(0),
  facing: z.literal([-1, 1]), roundWins: z.int().min(0).max(2), lastAck: z.uint32() });
export const Snapshot = z.object({ tick: z.uint32(), phase: z.enum(PHASES), round: z.int().min(1).max(3),
  roundTimer: z.int().min(0), p1: Fighter, p2: Fighter });              // replay/tests; wire = Colyseus schema
export const EndReason = z.enum(['ko','ringout','timeout','forfeit']);
const Q = z.number().min(0).max(1);
export const MatchResult = z.object({ matchId: z.uuid(), p1: Address, p2: Address, region: z.string().regex(/^[a-z]{3}$/),
  winner: Address.nullable(), reason: EndReason,
  rounds: z.array(z.object({ winner: z.enum(['p1','p2']).nullable(), reason: EndReason,
    endTick: z.uint32(), hp: z.tuple([z.int(), z.int()]) })).min(1).max(3),
  inputLog: z.base64(), resultHash: z.hash('sha256'), finalStateHash: z.string(),
  netQuality: z.tuple([Q, Q]), startedAt: z.iso.datetime(), endedAt: z.iso.datetime() });
// also: constants.ts (TICK_RATE 60, SNAPSHOT_HZ 20, INPUT_DELAY 2, BUFFER 6, MAX_AGE 30, AHEAD_MAX 3,
// GRACE_S 10, TIERS usd {rust:30,chrome:250,gold:1000,diamond:5000}); db.ts zod row types per table.
```

Colyseus `validate()` accepts zod 4 schemas directly (Standard Schema). Phase 2 still has to choose between plain zod-validated messages and Colyseus `defineInput`.

```ts
// packages/solana/src/index.ts — interfaces only; Phase 2/3 implements (web3.js v1, needed by the Meteora SDKs)
export type Cluster = 'devnet' | 'mainnet-beta' | 'localnet';
export type Tier = 'rust' | 'chrome' | 'gold' | 'diamond';
export interface GateResult { ok: boolean; usd: number; tokens: number; tier: Tier | null; source: 'jupiter' | 'curve'; checkedAt: string }
export interface BalanceGate { check(owner: string, o?: { bypassCache?: boolean }): Promise<GateResult> }
export interface PriceSource { readonly name: 'jupiter' | 'curve'; usdPrice(mint: string): Promise<number | null> }
export interface FeeClaimer { claimFees(o: { dryRun: boolean }): Promise<{ stage: 'dbc' | 'damm'; gmeRaw: bigint; cockRaw: bigint; sig?: string }> }
export interface Swapper { toSol(o: { mint: string; amountRaw: bigint; slippageBps: number; maxChunkUsd: number; dryRun: boolean }): Promise<{ lamports: bigint; sigs: string[] }> }
export interface PayoutSender { send(p: { to: string; lamports: bigint; idemKey: string }): Promise<{ sig: string }> }
export const LAMPORTS_PER_SOL = 1_000_000_000n;
export function tierForUsd(usd: number): Tier | null { /* real: 5000/1000/250/30 */ }
export function isValidAddress(s: string): boolean { /* real: bs58.decode(s).length === 32 */ }
```

Solana addresses have no checksum, despite what the spec says; validation means decoding the base58 and checking for 32 bytes. In Phase 2, also reject addresses that aren't on the ed25519 curve, because SOL sent to one of those can never be spent.

## Open questions for Sammy (spec contradictions)

1. **Who writes `balance_checks`?** The web app has no service role key under the spec's rules. My proposal: the game server writes the row from the queue-JWT claims and from the re-check at match start.
2. **Who does the match-start re-check,** given that "the game server never calls Helius"? My proposal: the game server calls an internal web route with a shared secret.
3. **Jupiter Price v2 is deprecated.** The default should be v3, which needs a `JUPITER_API_KEY`.

Sources: [Supabase explicit-grants change](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically) · [Supabase API keys](https://supabase.com/docs/guides/getting-started/api-keys) · [Supabase Cron install](https://supabase.com/docs/guides/cron/install) · [PGlite PG18 discussion](https://github.com/electric-sql/pglite/discussions/766) · [PGlite RLS example](https://github.com/majabri/investment-pal/pull/244) · [pnpm 11.0](https://pnpm.io/blog/releases/11.0) · [pnpm deploy regression](https://github.com/pnpm/pnpm/issues/13754) · [pnpm 11 on Vercel](https://andrewusher.dev/blog/upgrading-pnpm-11-vercel) · [Vercel pnpm 11 PR](https://github.com/vercel/vercel/pull/17450) · [Fly config reference](https://fly.io/docs/reference/configuration/) · [Jupiter Price v2 deprecation](https://hub.jup.ag/docs/price-api/v2) · Colyseus 0.18 source and the `create-colyseus-app@0.18.1` template (via jsDelivr).
