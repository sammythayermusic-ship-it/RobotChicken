-- COCKFIGHT schema v1: the spec's data model (tables, indexes, views).
--
-- Access model. apps/game and apps/worker write everything with the service
-- role; the web app's publishable ("anon") key reads two public views and
-- nothing else. RLS is enabled on every table with no policies, so even a
-- leaked table grant returns no rows to anon/authenticated. Grants are spelled
-- out because projects created after 2026-05-30 no longer auto-grant the API
-- roles, while older projects auto-grant ALL: the end state here is the same
-- on both.
--
-- Portability. Supabase runs Postgres 17 and the PGlite tests run 18, so
-- nothing 18-only (no uuidv7(), no virtual generated columns). Enumerations
-- are text + check, which are easy to extend and to mirror in zod.
-- Money is bigint lamports; token amounts are numeric raw base units.

-- Domains ---------------------------------------------------------------------

-- Any 32-byte value is 32..44 base58 chars. The full decode check stays in the
-- app (packages/solana isValidAddress); this keeps obvious garbage out.
create domain public.sol_address as text
  check (value ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
comment on domain public.sol_address is 'Solana address: 32 bytes, base58 (32-44 chars).';

-- Any 64-byte value is 64..88 base58 chars, so no valid signature is rejected.
create domain public.sol_signature as text
  check (value ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$');
comment on domain public.sol_signature is 'Solana transaction or message signature: 64 bytes, base58 (64-88 chars).';

-- Tables ----------------------------------------------------------------------

create table public.players (
  address      public.sol_address primary key,
  username     text check (username ~ '^[A-Za-z0-9_]{3,16}$'),
  username_sig public.sol_signature,
  -- No range check: ratings are updated alongside the match result, and a
  -- failed check there would also drop the result and its payout.
  elo          integer not null default 1000,
  -- Null until the address first passes the gate (below $30 has no tier).
  tier         text check (tier in ('rust', 'chrome', 'gold', 'diamond')),
  first_seen   timestamptz not null default now(),
  last_seen    timestamptz not null default now(),
  flags        jsonb not null default '{}' check (jsonb_typeof(flags) = 'object'),
  -- A username is claimed with a signed message, so names cannot be squatted.
  constraint players_username_signed check ((username is null) = (username_sig is null))
);
create unique index players_username_lower_key on public.players (lower(username));
comment on table public.players is 'One row per pasted wallet address.';

create table public.balance_checks (
  id         uuid primary key default gen_random_uuid(),
  -- No FK to players: the gate audits an address before its players row exists.
  address    public.sol_address not null,
  usd        numeric(14, 4) not null check (usd >= 0),
  tokens     numeric(30, 9) not null check (tokens >= 0),
  source     text not null check (source in ('jupiter', 'curve')),
  checked_at timestamptz not null default now()
);
create index balance_checks_address_checked_at_idx on public.balance_checks (address, checked_at desc);
comment on table public.balance_checks is 'Audit trail for the $COCK holding gate.';

create table public.matches (
  id              uuid primary key default gen_random_uuid(),
  p1              public.sol_address not null references public.players (address),
  p2              public.sol_address not null references public.players (address),
  -- Fly region code (iad, fra), or "local" in development.
  region          text not null check (region ~ '^[a-z]{3,8}$'),
  started_at      timestamptz not null default now(),
  ended_at        timestamptz,
  winner          public.sol_address references public.players (address),
  -- 'draw': double KO, sudden-death expiry, or the 5-round cap (sim matchWinner = 2).
  reason          text check (reason in ('ko', 'ringout', 'timeout', 'forfeit', 'draw')),
  rounds          jsonb not null default '[]',
  -- Replay source. A 5-round match is about 28.5k ticks, so 1 MiB is ample.
  input_log       bytea check (octet_length(input_log) <= 1048576),
  -- sha256(matchId + winner + inputLog), hex.
  result_hash     text check (result_hash ~ '^[0-9a-f]{64}$'),
  net_quality_p1  real check (net_quality_p1 between 0 and 1),
  net_quality_p2  real check (net_quality_p2 between 0 and 1),
  payout_lamports bigint not null default 0 check (payout_lamports >= 0),
  flag            text,
  constraint matches_distinct_players check (p1 <> p2),
  constraint matches_winner_is_player check (winner is null or winner in (p1, p2)),
  -- A row may be written at match start (ended_at and reason null) or at the end.
  constraint matches_ended_has_reason check ((ended_at is null) = (reason is null)),
  -- Unfinished and drawn matches have no winner; every other result has one.
  constraint matches_winner_iff_decisive check ((reason is null or reason = 'draw') = (winner is null)),
  -- A finished match records 1..5 rounds (a forfeit records the round it ended in).
  -- CASE guards jsonb_array_length, which raises on a non-array.
  constraint matches_rounds_shape check (
    case when jsonb_typeof(rounds) = 'array'
      then jsonb_array_length(rounds) <= 5 and (ended_at is null or jsonb_array_length(rounds) >= 1)
      else false
    end),
  -- Target of payouts (match_id, to_address): a win payout can only go to the
  -- match's winner, and never to a draw or an unfinished match.
  constraint matches_id_winner_key unique (id, winner)
);
create index matches_winner_ended_at_idx on public.matches (winner, ended_at desc);
create index matches_p1_p2_ended_at_idx on public.matches (p1, p2, ended_at desc);
create index matches_p2_ended_at_idx on public.matches (p2, ended_at desc);
comment on table public.matches is 'One row per match; input_log makes every match replayable.';

create table public.payouts (
  id              uuid primary key default gen_random_uuid(),
  kind            text not null check (kind in ('win', 'daily')),
  -- match_id for wins, "YYYY-MM-DD:rank" for daily rewards. A retry reuses the
  -- key, so a payout can never be enqueued twice.
  idem_key        text not null unique,
  match_id        uuid,
  to_address      public.sol_address not null,
  lamports        bigint not null check (lamports >= 0),
  status          text not null default 'pending'
    check (status in ('pending', 'sent', 'paid', 'deferred', 'failed', 'voided')),
  tx_sig          public.sol_signature unique,
  attempts        integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz,
  last_error      text,
  created_at      timestamptz not null default now(),
  paid_at         timestamptz,
  constraint payouts_kind_key check (
    (kind = 'win' and match_id is not null and idem_key = match_id::text)
    or (kind = 'daily' and match_id is null and idem_key ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}:([1-9]|10)$')),
  constraint payouts_paid_at_iff_paid check ((status = 'paid') = (paid_at is not null)),
  -- The signature is known once the transaction is signed, before it is sent.
  constraint payouts_sig_when_sent check (status not in ('sent', 'paid') or tx_sig is not null),
  constraint payouts_win_to_winner foreign key (match_id, to_address) references public.matches (id, winner)
);
create index payouts_status_created_at_idx on public.payouts (status, created_at);
create index payouts_match_id_to_address_idx on public.payouts (match_id, to_address);
create index payouts_to_address_created_at_idx on public.payouts (to_address, created_at desc);
create index payouts_paid_at_idx on public.payouts (paid_at desc) where status = 'paid';
comment on table public.payouts is 'SOL payouts (per win and daily); the worker pays them idempotently on idem_key.';

create table public.daily_rewards (
  day           date not null,
  rank          smallint not null check (rank between 1 and 10),
  address       public.sol_address not null references public.players (address),
  wins          integer not null check (wins >= 0),
  elo           integer not null,
  pool_lamports bigint not null check (pool_lamports >= 0),
  share_bps     integer not null check (share_bps between 0 and 10000),
  lamports      bigint not null check (lamports >= 0),
  payout_id     uuid unique references public.payouts (id),
  primary key (day, rank),
  unique (day, address),
  constraint daily_rewards_within_pool check (lamports <= pool_lamports)
);
create index daily_rewards_address_idx on public.daily_rewards (address);
comment on table public.daily_rewards is 'Snapshot of each UTC day''s top 10 and what each rank was paid.';

create table public.fee_claims (
  id                    uuid primary key default gen_random_uuid(),
  stage                 text not null check (stage in ('dbc', 'damm')),
  gme_claimed           numeric(40, 0) not null default 0 check (gme_claimed >= 0),
  cock_claimed          numeric(40, 0) not null default 0 check (cock_claimed >= 0),
  sol_after_swap        bigint check (sol_after_swap >= 0),
  player_share_lamports bigint check (player_share_lamports >= 0),
  project_share_gme     numeric(40, 0) check (project_share_gme >= 0),
  -- Unique: fee_claims feeds the payout size, so recording a claim twice would overpay.
  claim_sig             public.sol_signature unique,
  swap_sig              public.sol_signature unique,
  at                    timestamptz not null default now()
);
create index fee_claims_at_idx on public.fee_claims (at desc);
comment on table public.fee_claims is 'Every fee claim and swap (raw token units, lamports); feeds B24h and the public fee ticker.';

create table public.pool_snapshots (
  at                  timestamptz primary key default date_trunc('minute', now(), 'UTC'),
  creator_balance_gme numeric(40, 0) not null check (creator_balance_gme >= 0),
  hot_balance         bigint not null check (hot_balance >= 0),
  matches_24h         integer not null check (matches_24h >= 0),
  payout_per_win      bigint not null check (payout_per_win >= 0),
  daily_pool_lamports bigint not null check (daily_pool_lamports >= 0),
  market_cap_usd      numeric(20, 2) check (market_cap_usd >= 0),
  -- One row per minute: the worker upserts on the truncated timestamp.
  constraint pool_snapshots_whole_minute check (at = date_trunc('minute', at, 'UTC'))
);
comment on table public.pool_snapshots is 'One row per minute for the live pool chart (lamports, raw GME units).';

create table public.abuse_events (
  id          uuid primary key default gen_random_uuid(),
  -- No FK: fingerprint- or IP-only events may name an address that never played.
  address     public.sol_address,
  fingerprint text,
  ip_hash     text,
  kind        text not null check (kind ~ '^[a-z][a-z0-9_]{1,31}$'),
  match_id    uuid references public.matches (id),
  details     jsonb not null default '{}' check (jsonb_typeof(details) = 'object'),
  created_at  timestamptz not null default now(),
  resolved_by text,
  resolved_at timestamptz,
  constraint abuse_events_resolution check ((resolved_by is null) = (resolved_at is null))
);
create index abuse_events_open_idx on public.abuse_events (created_at desc) where resolved_by is null;
create index abuse_events_address_created_at_idx on public.abuse_events (address, created_at desc);
create index abuse_events_match_id_idx on public.abuse_events (match_id);
comment on table public.abuse_events is 'Admin review queue.';

-- Row level security: on everywhere, no policies. service_role has BYPASSRLS;
-- the owner (postgres) is exempt as owner, which the views below rely on.
-- Do not FORCE row level security, or pool_v and leaderboard_v go empty.
alter table public.players        enable row level security;
alter table public.balance_checks enable row level security;
alter table public.matches        enable row level security;
alter table public.payouts        enable row level security;
alter table public.daily_rewards  enable row level security;
alter table public.fee_claims     enable row level security;
alter table public.pool_snapshots enable row level security;
alter table public.abuse_events   enable row level security;

-- Public views ----------------------------------------------------------------
-- Neither view may ever expose ip_hash, fingerprint, flags, username_sig or input_log.

-- Per-address standings, refreshed every minute (see 20260923000100_cron.sql).
-- Windows: _today is the current UTC day (the daily leaderboard), _7d the
-- trailing 7 days, _all all time. A draw counts as a match for both players
-- and a win for neither. earned_lamports_* sums paid payouts of both kinds.
-- The daily reward job must rank a closed day from matches directly: _today
-- restarts at 00:00 UTC on the first refresh after midnight.
create materialized view public.leaderboard_v as
with bounds as (
  select date_trunc('day', now(), 'UTC') as day_start, now() - interval '7 days' as week_start
),
sides as (
  select m.p1 as address, m.winner is not distinct from m.p1 as won, m.ended_at
  from public.matches m where m.ended_at is not null
  union all
  select m.p2, m.winner is not distinct from m.p2, m.ended_at
  from public.matches m where m.ended_at is not null
),
record as (
  select s.address,
    (count(*) filter (where s.won and s.ended_at >= b.day_start))::integer  as wins_today,
    (count(*) filter (where s.ended_at >= b.day_start))::integer            as matches_today,
    (count(*) filter (where s.won and s.ended_at >= b.week_start))::integer as wins_7d,
    (count(*) filter (where s.ended_at >= b.week_start))::integer           as matches_7d,
    (count(*) filter (where s.won))::integer                                as wins_all,
    count(*)::integer                                                       as matches_all
  from sides s cross join bounds b
  group by s.address
),
earned as (
  select p.to_address as address,
    coalesce(sum(p.lamports) filter (where p.paid_at >= b.week_start), 0)::bigint as earned_lamports_7d,
    sum(p.lamports)::bigint as earned_lamports_all
  from public.payouts p cross join bounds b
  where p.status = 'paid'
  group by p.to_address
)
select
  r.address,
  coalesce(pl.username, 'anon-' || right(r.address, 4)) as display_name,
  pl.elo,
  pl.tier,
  r.wins_today,
  r.matches_today,
  r.wins_7d,
  r.matches_7d,
  round(r.wins_7d::numeric / nullif(r.matches_7d, 0), 4)   as win_rate_7d,
  coalesce(e.earned_lamports_7d, 0)::bigint                  as earned_lamports_7d,
  r.wins_all,
  r.matches_all,
  round(r.wins_all::numeric / nullif(r.matches_all, 0), 4) as win_rate_all,
  coalesce(e.earned_lamports_all, 0)::bigint                 as earned_lamports_all,
  now() as refreshed_at
from record r
join public.players pl on pl.address = r.address
left join earned e on e.address = r.address;

-- REFRESH ... CONCURRENTLY needs a unique index on plain columns.
create unique index leaderboard_v_address_key on public.leaderboard_v (address);
comment on materialized view public.leaderboard_v is
  'Public standings per address (UTC day, trailing 7 days, all time). Refreshed every minute.';

-- The latest pool snapshot plus trailing-24h fee and payout totals: always
-- exactly one row (snapshot columns are null until the worker writes one).
-- Owner's rights on purpose (security_invoker off, the default): anon has no
-- grant on the base tables and RLS would hide their rows anyway, so an
-- invoker view could not work. It is safe because every column is a public
-- aggregate. security_barrier is defense in depth: a caller's predicates are
-- never evaluated against base-table rows the view does not return.
create view public.pool_v with (security_barrier = true) as
select
  s.at as snapshot_at,
  s.creator_balance_gme,
  s.hot_balance,
  s.matches_24h,
  s.payout_per_win,
  s.daily_pool_lamports,
  s.market_cap_usd,
  f.claims_24h,
  f.gme_claimed_24h,
  f.cock_claimed_24h,
  f.sol_after_swap_24h,
  f.player_share_lamports_24h,
  f.project_share_gme_24h,
  p.paid_count_24h,
  p.paid_lamports_24h,
  now() as computed_at
from (
  select
    count(*)::integer                                    as claims_24h,
    coalesce(sum(gme_claimed), 0)                        as gme_claimed_24h,
    coalesce(sum(cock_claimed), 0)                       as cock_claimed_24h,
    coalesce(sum(sol_after_swap), 0)::bigint             as sol_after_swap_24h,
    coalesce(sum(player_share_lamports), 0)::bigint      as player_share_lamports_24h,
    coalesce(sum(project_share_gme), 0)                  as project_share_gme_24h
  from public.fee_claims
  where at > now() - interval '24 hours'
) f
cross join (
  select count(*)::integer as paid_count_24h, coalesce(sum(lamports), 0)::bigint as paid_lamports_24h
  from public.payouts
  where status = 'paid' and paid_at > now() - interval '24 hours'
) p
left join lateral (
  select * from public.pool_snapshots order by at desc limit 1
) s on true;
comment on view public.pool_v is
  'Public pool numbers for the front page: latest snapshot plus trailing-24h fee and payout totals.';

-- Privileges ------------------------------------------------------------------
-- Start every object from zero (legacy projects auto-granted ALL to the API
-- roles), then grant exactly what each caller needs. TRUNCATE is never granted.

revoke all on table
  public.players, public.balance_checks, public.matches, public.payouts,
  public.daily_rewards, public.fee_claims, public.pool_snapshots, public.abuse_events,
  public.leaderboard_v, public.pool_v
from anon, authenticated, service_role;

-- service_role: the game server and the worker. Money and audit rows are
-- append/update only; DELETE exists only where retention needs it.
grant select, insert, update         on table public.players        to service_role;
grant select, insert, delete         on table public.balance_checks to service_role;
grant select, insert, update         on table public.matches        to service_role;
grant select, insert, update         on table public.payouts        to service_role;
grant select, insert, update         on table public.daily_rewards  to service_role;
grant select, insert, update         on table public.fee_claims     to service_role;
grant select, insert, update, delete on table public.pool_snapshots to service_role;
grant select, insert, update         on table public.abuse_events   to service_role;
grant select on table public.leaderboard_v, public.pool_v to service_role;
-- MAINTAIN (Postgres 17+) lets the worker refresh the leaderboard where
-- pg_cron is unavailable, or right before it reads it.
grant maintain on table public.leaderboard_v to service_role;

-- The web app's keys: the two public views, read-only.
grant select on table public.leaderboard_v, public.pool_v to anon, authenticated;

-- Future tables and sequences created by postgres (migrations, the SQL
-- editor) start the same way: service_role may read and write, the web keys
-- get nothing until a migration grants it. Functions are not covered: Postgres
-- grants EXECUTE to PUBLIC globally, which a per-schema default cannot undo,
-- so a function added to public must revoke it itself (see supabase/README.md).
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant select, insert, update, delete on tables to service_role;
alter default privileges for role postgres in schema public grant usage, select on sequences to service_role;
