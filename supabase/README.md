# Supabase

The database schema for COCKFIGHT, as plain SQL migrations for the Supabase
CLI. The tests run the migrations on PGlite (Postgres in WASM), so neither
Docker nor the CLI is needed to develop or test them.

| File | What it does |
|---|---|
| `config.toml` | CLI settings: project id `cockfight`, Postgres 17, no seed |
| `migrations/20260923000000_init.sql` | The 9 tables, indexes, RLS, the public views, and all grants |
| `migrations/20260923000100_cron.sql` | pg_cron: refresh `leaderboard_v` every minute, purge old cron logs |

## Applying to a Supabase project

Unverified: the CLI is not installed here, so these commands have not been run
against a real project.

```sh
pnpm dlx supabase login
pnpm dlx supabase link --project-ref <project-ref>   # asks for the database password
pnpm dlx supabase db push --dry-run                  # lists the migrations it would apply
pnpm dlx supabase db push
```

`db push` applies, in version order, every file in `migrations/` that is not yet
recorded in `supabase_migrations.schema_migrations`, connecting as `postgres`.
Applied migrations are never edited: change the schema with a new file.

After the first push, check in the SQL editor:

```sql
select jobname, schedule, command from cron.job;          -- two cockfight_* jobs
select * from public.pool_v;                                 -- exactly one row
set role anon; select count(*) from public.payouts; reset role;  -- permission denied
```

Requirements:
- **Postgres 17 or later.** `grant maintain` does not exist before 17.
- **`public` exposed in the Data API** (Settings, API). It is by default.
- **Keys.** The web app uses the publishable key (the `anon` role); apps/game
  and apps/worker use the secret key (the `service_role` role). The env names
  keep the spec's `*_ANON_KEY` / `*_SERVICE_ROLE_KEY`.

## Access model

- **Writes:** `service_role` only (apps/game and apps/worker). It has
  BYPASSRLS. Per table it gets exactly what it needs:
  - money and audit rows (`payouts`, `matches`, `fee_claims`, `daily_rewards`,
    `abuse_events`, `players`) can be inserted and updated but never deleted;
  - `fee_swaps` can only be inserted: a swap is recorded once it is confirmed;
  - `balance_checks` and `pool_snapshots` also allow DELETE, for retention;
  - TRUNCATE is never granted.
- **Reads for the web app:** `anon` and `authenticated` can SELECT
  `leaderboard_v`, `pool_v` and `match_replay_v`, and nothing else. A test
  lists every relation they can read and fails on anything else.
- **RLS:** enabled on every table, with no policies. Even if a table grant
  leaked to `anon`, it would see no rows.
- **Why the grants are explicit.** Projects created before 2026-05-30
  auto-grant ALL on new public tables to `anon`, `authenticated` and
  `service_role`. Newer projects grant nothing. The init migration revokes
  everything and then grants per object, so both kinds of project end up the
  same. The tests check this in both modes.
- **Future tables, sequences and functions** created by `postgres` in `public`
  default to the same model: `service_role` gets SELECT/INSERT/UPDATE/DELETE
  (USAGE/SELECT on sequences, EXECUTE on functions), and `anon`/`authenticated`
  get nothing.
- **Functions need a global default.** Postgres grants EXECUTE on every new
  function to PUBLIC, which every role has. A per-schema default cannot undo
  that; the global one (`alter default privileges for role postgres revoke
  execute on functions from public`, no `in schema`) does. It therefore also
  applies to functions `postgres` creates in *other* schemas: grant EXECUTE on
  those explicitly to whoever calls them (an RLS helper, for example, to
  `anon`/`authenticated`). A test fails if `anon` or `authenticated` can
  execute any function in `public` that is not on its allowlist (empty
  today).

### Checklist for a new migration

1. Name it `<YYYYMMDDHHMMSS>_<snake_name>.sql`. The CLI silently skips other
   names; the test harness rejects them.
2. `enable row level security` on every new table.
3. Grant `service_role` only what it needs, if the defaults are too broad.
4. A new public view must never expose `ip_hash`, `fingerprint`, `flags`,
   `flag`, `username_sig` or `details` (the test's `PRIVATE_COLUMNS`), and must
   be added to the test's `VIEWS`. `input_log` is public on purpose (see
   `match_replay_v`). Decide whether it is an owner-rights or an invoker view
   (see `pool_v` below).
5. Functions: `anon`/`authenticated` get no EXECUTE by default; grant it only
   to a function the web app must call, and add it to the test's
   `ANON_CALLABLE`. Prefer `security invoker` (the default): the worker calls
   as `service_role`, which already has the grants and bypasses RLS. A
   `security definer` function needs `set search_path = ''` and belongs in a
   schema the Data API does not expose.
6. Nothing Postgres 18 only (`uuidv7()`, virtual generated columns, …): PGlite
   runs 18, Supabase runs 17.
7. `pnpm vitest run --project tools migrations` must pass.

## Tables

All money is `bigint` lamports; token amounts are `numeric(40,0)` raw base
units (the on-chain integer, never a UI amount), including
`balance_checks.tokens`, which carries the mint's `decimals` beside it. A
`numeric(40,0)` column rounds a fractional input instead of rejecting it, so
writers pass base units as a `bigint` or an integer string, never a JS number
with decimals. Addresses and signatures use the `sol_address` and `sol_signature`
domains (text with a base58 check). Enumerations are text with a check
constraint, so zod can mirror them and adding a value is a one-line migration.

| Table | Purpose | Notes |
|---|---|---|
| `players` | One row per pasted wallet address | `tier` is null until the address passes the gate. A username needs its signed message (`username_sig`). Usernames are unique case-insensitively. |
| `balance_checks` | Audit trail for the $COCK holding gate | No FK to `players`: the gate checks an address before its row exists. `tokens` is raw base units and `decimals` the mint's, so the UI amount is `tokens / 10^decimals`. |
| `matches` | One row per match; `input_log` makes it replayable | Can be written at match start (`ended_at`, `reason`, `winner` null) or at the end. A finished match has 1–5 rounds, and a forfeit records the round it ended in. `reason = 'draw'` has `winner` null; every other reason has a winner. See [Match reasons](#match-reasons). |
| `payouts` | SOL payouts, one per win and one per daily rank | `idem_key` is unique: the match id for a win, `YYYY-MM-DD:rank` for daily. A win payout must go to that match's winner (a composite FK to `matches (id, winner)`), so a drawn or unfinished match cannot be paid, and once a match has a win payout its winner cannot change. `sent`/`paid` need `tx_sig`; `paid` exactly when `paid_at` is set. An address gets at most one daily payout per day, whatever its rank (`payouts_daily_day_address_key`). |
| `daily_rewards` | Each UTC day's top 10 and what each rank was paid | One row per rank and per address per day. `payout_id` must name a payout to the same address for the same lamports (a composite FK), and once linked, that payout's recipient and amount cannot change. |
| `fee_claims` | Every fee claim | Feeds B₂₄ₕ and the fee ticker. `claim_sig` is unique, so a claim recorded twice cannot inflate payouts. A row without `claim_sig` (a dry run) is not counted in `pool_v`. |
| `fee_swaps` | Every swap of claimed fees to SOL, one row per transaction | The worker swaps in chunks of at most $2k, so a claim has any number of swaps. `swap_sig` is the primary key; `lamports` is that chunk's SOL out, and a claim's SOL after swap is the sum of its rows. Each swap belongs to exactly one claim. |
| `pool_snapshots` | One row per minute for the live chart | `at` must be a whole minute (UTC); the worker upserts on it. |
| `abuse_events` | The admin review queue | `resolved_by` and `resolved_at` are set together. |

### The daily reward job (Phase 3)

`idem_key` makes each `day:rank` payout idempotent, but ranks are not stable:
ties break on live ELO, and an admin can clear a flag after midnight. If a
retry re-ranks, it can skip `day:1 → A` (already enqueued for B) and then try
`day:2 → B`. The schema turns that into a unique violation on
`payouts_daily_day_address_key` instead of a second payout to B, but the job
must not rely on it:
- rank the closed day once, from `matches` directly (not `leaderboard_v`);
- write all `daily_rewards` rows and their `payouts` in one transaction (one
  RPC or one SQL statement, never per-row client inserts);
- on a retry, reuse the stored `daily_rewards` rows for that day and never
  re-rank.

### Match reasons

`matches.reason` extends the spec's `ko/ringout/timeout/forfeit` with the ways
the sim can also end a match. The writer maps the sim's final state (the
mapping belongs in `packages/shared`, next to the row types):

| Final state | `reason` | `winner` |
|---|---|---|
| `matchWinner = 2` (double KO, sudden-death expiry, or level at the round cap) | `draw` | null |
| The loser disconnected past the grace period | `forfeit` | the connected player |
| The winner won the final round | that round's reason: `ko`, `ringout`, `timeout`, or `sudden_death` (sim `suddenDeath`) | the winner |
| Won on round count at the round cap, the final round drawn | `decision` | the winner |

The sim's final state keeps the last round's reason, so a match won in round
1 whose rounds 2–5 were all drawn ends with `sdExpired` and a winner. Mapping
that straight to `draw` violates `matches_winner_iff_decisive`, and since the
result and its payout are written in one transaction, it would lose both.

### Differences from the spec's data model

- **`fee_swaps`** is a 9th table. The spec puts one `swap_sig` and one
  `sol_after_swap` on each `fee_claims` row, but a claim is swapped in several
  chunks (`Swapper.toSol` returns several signatures), and chunk rows in
  `fee_claims` would be counted as claims. So `fee_claims` has neither column:
  each swap is a `fee_swaps` row, and SOL after swap is derived from them.
  Phase 3's `Swapper` must report each chunk's signature *and* lamports.
- **`matches.reason`** adds `sudden_death`, `decision` and `draw` (see [Match reasons](#match-reasons)).
- **`balance_checks.decimals`** records the mint's decimals next to the raw
  `tokens` amount.

The spec's indexes are all present: `matches (winner, ended_at desc)`,
`matches (p1, p2, ended_at desc)` for the pairing caps, and
`payouts (status, created_at)` for the worker's poll. Every foreign key also
has an index.

## Public views

**`leaderboard_v`** (materialized, refreshed every minute by pg_cron). One row
per address with at least one finished match. Columns:
- `display_name`: the username, or `anon-XXXX` (the address's last 4 characters);
- `elo`, `tier`;
- `wins_*` and `matches_*` for three windows: `_today` (the current UTC day,
  for the daily leaderboard), `_7d` (the trailing 7 days) and `_all` (all time);
- `win_rate_7d` and `win_rate_all` (4 decimals, null with no matches);
- `earned_lamports_7d` and `earned_lamports_all`: paid payouts of both kinds.

There is deliberately no `refreshed_at` column. `refresh materialized view
concurrently` diffs whole rows and rewrites every row that differs, so a
column that changes on every refresh (such as `now()`) would rewrite every
row every minute, with writes and WAL growing with the all-time player count
rather than with activity. A test checks that a refresh with no data change
rewrites nothing. If the UI needs an "updated N s ago" label, add a one-row
table that the cron command updates after the refresh, and expose its time
through `pool_v`.

A draw counts as a match for both players and a win for neither. The unique
index on `address` is what allows `refresh materialized view concurrently`, so
readers are never blocked. Where pg_cron is unavailable, the worker (as
`service_role`, which holds MAINTAIN on the view) can run that refresh itself.
The daily reward job must rank a closed day from `matches` directly: `_today`
restarts on the first refresh after 00:00 UTC.

**`pool_v`** (a plain view, always exactly one row). It holds the latest
`pool_snapshots` row (all null until the worker writes one) and trailing-24h
totals from `fee_claims` (with a claim transaction), their `fee_swaps`, and
paid `payouts`. The 24 h window is by claim time, like B₂₄ₕ. It runs with
its owner's rights (`security_invoker` off) on purpose. `anon` has no grant on
the base tables, and RLS would hide their rows anyway, so an invoker view
could not work. The view is safe because every column is a public aggregate.
The front page polls it: Realtime cannot push changes from RLS-protected
tables to `anon`.

**`match_replay_v`** (a plain view, one row per finished match). The data
behind the public replay page `/m/[id]`: `id`, `p1`, `p2`, `p1_name` and
`p2_name` (the username or `anon-XXXX`, as on the leaderboard), `winner`,
`reason`, `rounds`, `input_log`, `result_hash`, `started_at`, `ended_at`.
Matches still in progress are left out, and so are `region`, net quality,
`payout_lamports` and the abuse `flag`. Like `pool_v` it runs with its owner's
rights and has `security_barrier`; a lookup by `id` still uses the primary
key (a test checks the plan). Fetch one match by `id`; select a list without
`input_log`, which can be up to 1 MiB per row.

*Decision: replays are served from this view.* The spec requires a public
replay page for any match ("deterministic playback from the input log") and
also says the web app reads public views only, with the service-role key
kept to apps/game and apps/worker. The input log is two arrays of `{t, b}`
(tick, buttons) and holds nothing private, so it is exposed here rather than
through an HTTP endpoint on apps/game or a Storage bucket. The rule for public
views is therefore about `ip_hash`, `fingerprint`, `flags`, `flag`,
`username_sig` and `details`, never about `input_log`.

## Expected Supabase advisor findings

These are intentional; do not "fix" them.

| Lint | Level | Object | Why it is fine |
|---|---|---|---|
| `rls_enabled_no_policy` | Info | all 9 tables | Deny-by-default for the web keys is the design. `service_role` bypasses RLS. |
| `security_definer_view` | Error | `pool_v`, `match_replay_v` | They have to read tables `anon` cannot. `pool_v` exposes only aggregates, `match_replay_v` only public match data, and both have `security_barrier`. |
| `materialized_view_in_api` | Warn | `leaderboard_v` | The leaderboard is public by design and has no private columns. |
| `unused_index` | Info | several | Until real traffic arrives. |

If the `security_definer_view` errors have to go, the alternative is an invoker
view over a `security definer` function in an unexposed schema, with a pinned
`search_path` and EXECUTE granted only to `anon`/`authenticated`.

## pg_cron

`20260923000100_cron.sql` enables pg_cron (in `pg_catalog`, as Supabase
documents) and schedules two jobs as `postgres`:
- `cockfight_refresh_leaderboard_v`, every minute;
- `cockfight_purge_cron_history`, daily at 03:17 UTC, which deletes
  `cron.job_run_details` rows older than 7 days (the refresh alone logs 1,440
  rows a day).

`cron.schedule` replaces a job with the same name, so re-running is safe. Where
pg_cron is not in `pg_available_extensions` (PGlite, plain Postgres), the
migration only raises a NOTICE.

## Tests

`tools/test/migrations.test.ts` runs on PGlite through `tools/src/db/harness.ts`.
The harness recreates what the migrations depend on:
- `supabase_admin` is the superuser, and `postgres` is not (as on Supabase).
  Migrations run as `postgres`, each in a transaction, and any WARNING fails
  the run.
- `anon`, `authenticated` and `service_role` have Supabase's attributes.
- The grant mode is either `legacy` (auto-grants) or `strict` (none).

The schema tests run in both modes: RLS, the privilege matrix, default
privileges for later tables, sequences and functions, denied access,
every relation `anon` can read and its columns, the public views as `anon`
(replays included), service-role writes, draws and every match reason, payout
idempotency (including a daily retry that re-ranks), fee swaps, every check
constraint, leaderboard aggregates after a concurrent refresh and a refresh
that rewrites nothing, FK indexes, and the cron guard.

Gaps, each checked some other way where possible:
- **Postgres version.** PGlite is 18 and Supabase is 17. A test scans the SQL
  for 18-only features.
- **pg_cron.** PGlite has no pg_cron, so the scheduled branch never runs in
  tests. The refresh command itself is executed as `postgres`.
- **Real roles.** Supabase's own roles and the CLI's transaction handling are
  emulated, not the real thing.

```sh
pnpm vitest run --project tools migrations
```

Phase 3 idempotency tests can reuse `freshDb(mode)` and `as(db, role, fn)` from
the harness.
