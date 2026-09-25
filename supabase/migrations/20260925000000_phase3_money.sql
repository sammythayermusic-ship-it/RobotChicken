-- Phase 3: the money. Sammy launches on pump.fun paired to PUMP (2026-09-24),
-- so fees arrive in PUMP and players are paid in PUMP: no swap to SOL. The
-- init schema's SOL/GME money tables (all empty: no payout code ever ran)
-- become the PUMP ledger described in docs/plan-phase3.md.
--
-- Amounts are raw base units of the payout mint (numeric(40,0), PUMP has 6
-- decimals); dollars are numeric(14,4) at the price of the moment.
--
-- Access model unchanged: service_role (worker, game server) writes through
-- functions or the Data API; the web keys read the public views only.

-- The public views are rebuilt at the end; they must go first, since a
-- column they read cannot change type underneath them.
drop materialized view public.leaderboard_v;
drop view public.pool_v;

-- Players ---------------------------------------------------------------------

alter table public.players
  add column flagged      boolean not null default false,
  add column banned_until timestamptz;
comment on column public.players.flagged is 'Under review: wins book no payout and the wallet is left out of the daily top 10.';
comment on column public.players.banned_until is 'Refused by the gate until then (admin ban).';

-- Matches ---------------------------------------------------------------------

alter table public.matches drop column payout_lamports;
alter table public.matches
  add column tier_paid     text check (tier_paid in ('rust', 'chrome', 'gold')),
  add column quality_bps   smallint check (quality_bps in (0, 5000, 10000)),
  add column payout        numeric(40, 0) not null default 0 check (payout >= 0),
  add column payout_reason text check (payout_reason in ('paid', 'draw', 'open', 'quality', 'flagged', 'cap_wins', 'cap_opponent', 'no_pool')),
  -- Hashes only (sha256 of the IP / the browser fingerprint with a server
  -- secret), never public: the per-wallet caps count by these as well.
  add column p1_ip_hash    text check (p1_ip_hash ~ '^[0-9a-f]{16,64}$'),
  add column p2_ip_hash    text check (p2_ip_hash ~ '^[0-9a-f]{16,64}$'),
  add column p1_fp         text check (p1_fp ~ '^[0-9a-f]{16,64}$'),
  add column p2_fp         text check (p2_fp ~ '^[0-9a-f]{16,64}$');
comment on column public.matches.tier_paid is 'The tier the win was paid at: the lower tier of a cross-tier pair.';
comment on column public.matches.payout is 'What the win booked (raw units); 0 with payout_reason saying why.';
create index matches_p1_ip_hash_ended_at_idx on public.matches (p1_ip_hash, ended_at desc);
create index matches_p2_ip_hash_ended_at_idx on public.matches (p2_ip_hash, ended_at desc);
create index matches_p1_fp_ended_at_idx on public.matches (p1_fp, ended_at desc);
create index matches_p2_fp_ended_at_idx on public.matches (p2_fp, ended_at desc);

-- Payouts ---------------------------------------------------------------------

-- Amounts in PUMP, keys "win:<matchId>" / "daily:<day>:<rank>", the day and
-- rank as columns, the dollar value at booking, and sent_at for the caps.
alter table public.daily_rewards drop constraint daily_rewards_payout_matches;
alter table public.payouts drop constraint payouts_id_to_address_lamports_key;
drop index public.payouts_daily_day_address_key;
alter table public.payouts drop constraint payouts_kind_key;
alter table public.payouts rename column lamports to amount;
alter table public.payouts
  alter column amount type numeric(40, 0),
  drop constraint payouts_lamports_check,
  add constraint payouts_amount_check check (amount > 0),
  add column day     date,
  add column rank    smallint check (rank between 1 and 10),
  add column usd     numeric(14, 4) not null default 0 check (usd >= 0),
  add column sent_at timestamptz,
  add constraint payouts_kind_key check (
    (kind = 'win' and match_id is not null and day is null and rank is null and idem_key = 'win:' || match_id::text)
    or (kind = 'daily' and match_id is null and day is not null and rank is not null and idem_key = 'daily:' || to_char(day, 'YYYY-MM-DD') || ':' || rank::text)),
  add constraint payouts_sent_at_when_sent check (status not in ('sent', 'paid') or sent_at is not null),
  add constraint payouts_id_to_address_amount_key unique (id, to_address, amount);
-- At most one daily payout per address per day, whatever its rank (a retry
-- that re-ranks must fail rather than pay twice; see the init migration).
create unique index payouts_daily_day_address_key on public.payouts (day, to_address) where kind = 'daily';
create index payouts_sent_at_idx on public.payouts (sent_at desc) where status in ('sent', 'paid');
create index payouts_day_idx on public.payouts (day) where kind = 'daily';
comment on table public.payouts is 'Payouts in the payout mint (per win and daily); the worker pays them idempotently on idem_key.';
comment on column public.payouts.sent_at is 'When the signed transaction was recorded, before broadcast: the caps and windows count from here.';

alter table public.daily_rewards rename column pool_lamports to pool;
alter table public.daily_rewards rename column lamports to amount;
alter table public.daily_rewards
  alter column pool type numeric(40, 0),
  alter column amount type numeric(40, 0),
  drop column elo,
  add constraint daily_rewards_payout_matches foreign key (payout_id, address, amount)
    references public.payouts (id, to_address, amount);
comment on table public.daily_rewards is 'Snapshot of each UTC day''s top 10 and what each rank was paid (raw units).';

-- The closed day's pool, written by the midnight job whether or not anyone
-- ranked: its existence is what makes the job idempotent on the day.
create table public.daily_pools (
  day        date primary key,
  gross      numeric(40, 0) not null check (gross >= 0),
  seed_part  numeric(40, 0) not null default 0 check (seed_part >= 0),
  pool       numeric(40, 0) not null check (pool >= 0),
  rewards    smallint not null default 0 check (rewards between 0 and 10),
  ranked_at  timestamptz not null default now()
);
comment on table public.daily_pools is 'One row per closed UTC day: the fees of that day, the seed part and the pool paid to the top 10.';

-- Fees ------------------------------------------------------------------------

drop table public.fee_swaps;
alter table public.fee_claims rename column gme_claimed to gross;
alter table public.fee_claims rename column player_share_lamports to player_share;
alter table public.fee_claims rename column project_share_gme to project_share;
alter table public.fee_claims rename column claim_sig to sig;
alter table public.fee_claims
  drop constraint fee_claims_stage_check,
  drop constraint fee_claims_gme_claimed_check,
  add constraint fee_claims_gross_check check (gross >= 0),
  drop constraint fee_claims_claim_sig_key,
  add constraint fee_claims_sig_key unique (sig),
  add constraint fee_claims_stage_check check (stage in ('curve', 'amm')),
  drop column cock_claimed,
  alter column player_share type numeric(40, 0),
  alter column player_share set not null,
  alter column project_share set not null,
  alter column sig set not null,
  add column price_usd numeric(20, 10) check (price_usd >= 0),
  add constraint fee_claims_shares_sum check (player_share + project_share = gross);
comment on table public.fee_claims is 'Every distribution of creator fees (raw units of the quote token): gross and its player / project split. Feeds B24 and the front page.';
comment on column public.fee_claims.price_usd is 'USD per whole payout token at the claim, from Jupiter.';

-- The treasury's other moves. Together with fee_claims and payouts these
-- give the ledger allowance: player_share + seed draws − payouts sent − sweeps.
create table public.seed (
  id         boolean primary key default true check (id),
  original   numeric(40, 0) not null default 0 check (original >= 0),
  remaining  numeric(40, 0) not null default 0 check (remaining >= 0 and remaining <= original),
  updated_at timestamptz not null default now()
);
insert into public.seed default values;
comment on table public.seed is 'Sammy''s launch seed (raw units): the original for the 1/14 rule, what is left. One row.';

create table public.seed_draws (
  day       date primary key,
  win       numeric(40, 0) not null check (win >= 0),
  daily     numeric(40, 0) not null check (daily >= 0),
  total     numeric(40, 0) not null,
  shortfall numeric(40, 0) not null check (shortfall >= 0),
  sig       public.sol_signature unique,
  at        timestamptz not null default now(),
  constraint seed_draws_total_is_sum check (total = win + daily),
  constraint seed_draws_sig_iff_drawn check ((total = 0) = (sig is null))
);
comment on table public.seed_draws is 'The seed draw booked at 00:00 UTC for each day (0 when fees covered the guarantees).';

create table public.sweeps (
  sig    public.sol_signature primary key,
  amount numeric(40, 0) not null check (amount > 0),
  at     timestamptz not null default now()
);
comment on table public.sweeps is 'Hot wallet → cold wallet: what the hot wallet did not need to keep.';

-- Pool state ------------------------------------------------------------------

-- One row, rewritten every minute by the worker: what the next win pays per
-- tier, which record_match books from, plus the figures the site shows.
create table public.pool_state (
  id               boolean primary key default true check (id),
  computed_at      timestamptz not null default now(),
  price_usd        numeric(20, 10) not null check (price_usd >= 0),
  decimals         smallint not null check (decimals between 0 and 18),
  win_rust         numeric(40, 0) not null check (win_rust >= 0),
  win_chrome       numeric(40, 0) not null check (win_chrome >= 0),
  win_gold         numeric(40, 0) not null check (win_gold >= 0),
  per_win_budget   numeric(40, 0) not null check (per_win_budget >= 0),
  weighted_milli   numeric(40, 0) not null check (weighted_milli >= 0),
  daily_pool       numeric(40, 0) not null check (daily_pool >= 0),
  hot_target       numeric(40, 0) not null check (hot_target >= 0),
  gross_24h        numeric(40, 0) not null check (gross_24h >= 0),
  gross_today      numeric(40, 0) not null check (gross_today >= 0),
  allowance        numeric(40, 0) not null,
  outstanding      numeric(40, 0) not null check (outstanding >= 0),
  -- Floors and caps per tier at this price, and anything else the site shows.
  detail           jsonb not null default '{}' check (jsonb_typeof(detail) = 'object')
);
comment on table public.pool_state is 'The live pool (one row, every minute): what the next win pays per tier and today''s daily pool.';

drop table public.pool_snapshots;
create table public.pool_snapshots (
  at          timestamptz primary key default date_trunc('minute', now(), 'UTC'),
  price_usd   numeric(20, 10) not null check (price_usd >= 0),
  win_rust    numeric(40, 0) not null check (win_rust >= 0),
  daily_pool  numeric(40, 0) not null check (daily_pool >= 0),
  gross_24h   numeric(40, 0) not null check (gross_24h >= 0),
  weighted_milli numeric(40, 0) not null check (weighted_milli >= 0),
  constraint pool_snapshots_whole_minute check (at = date_trunc('minute', at, 'UTC'))
);
comment on table public.pool_snapshots is 'One row per minute for the pool chart.';

-- Admin knobs and the pause switch, read by the worker every minute.
create table public.settings (
  key        text primary key check (key ~ '^[a-z][a-z0-9_]{1,63}$'),
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by text
);
comment on table public.settings is '/admin knobs (p_min_usd, guarantees, caps…) and payouts_paused; env holds the defaults.';

-- RLS and grants for the new tables (default privileges already give
-- service_role the DML on tables postgres creates; stated for the record).
alter table public.daily_pools    enable row level security;
alter table public.seed           enable row level security;
alter table public.seed_draws     enable row level security;
alter table public.sweeps         enable row level security;
alter table public.pool_state     enable row level security;
alter table public.pool_snapshots enable row level security;
alter table public.settings       enable row level security;
revoke all on table public.daily_pools, public.seed, public.seed_draws, public.sweeps, public.pool_state, public.pool_snapshots, public.settings
  from anon, authenticated, service_role;
grant select, insert, update         on table public.daily_pools    to service_role;
grant select, update                 on table public.seed           to service_role;
grant select, insert                 on table public.seed_draws     to service_role;
grant select, insert                 on table public.sweeps         to service_role;
grant select, insert, update         on table public.pool_state     to service_role;
grant select, insert, update, delete on table public.pool_snapshots to service_role;
grant select, insert, update, delete on table public.settings       to service_role;

-- Functions -------------------------------------------------------------------

-- Everything the treasury needs for one recompute or pay pass, in one round trip.
create function public.treasury_window(p_now timestamptz default now())
returns table (
  gross_24h numeric, gross_today numeric, player_share_24h numeric, weighted_24h_milli numeric,
  allowance numeric, sent_last_hour numeric, sent_today numeric, outstanding numeric,
  seed_win numeric, seed_daily numeric, seed_total numeric
)
language sql
stable
set search_path = ''
as $$
  with c as (
    select
      coalesce(sum(gross)        filter (where at > p_now - interval '24 hours' and at <= p_now), 0) as gross_24h,
      coalesce(sum(gross)        filter (where at >= date_trunc('day', p_now, 'UTC') and at <= p_now), 0) as gross_today,
      coalesce(sum(player_share) filter (where at > p_now - interval '24 hours' and at <= p_now), 0) as player_share_24h,
      coalesce(sum(player_share), 0) as player_share_all
    from public.fee_claims
  ),
  m as (
    select coalesce(sum(case tier_paid when 'gold' then 6000 when 'chrome' then 2500 else 1000 end), 0) as weighted_24h_milli
    from public.matches
    where ended_at > p_now - interval '24 hours' and ended_at <= p_now and tier_paid is not null
  ),
  p as (
    select
      coalesce(sum(amount) filter (where status in ('sent', 'paid')), 0) as sent_all,
      coalesce(sum(amount) filter (where status in ('sent', 'paid') and kind = 'win' and sent_at > p_now - interval '1 hour'), 0) as sent_last_hour,
      coalesce(sum(amount) filter (where status in ('sent', 'paid') and sent_at >= date_trunc('day', p_now, 'UTC')), 0) as sent_today,
      coalesce(sum(amount) filter (where status in ('pending', 'deferred')), 0) as outstanding
    from public.payouts
  ),
  s as (
    select coalesce(sum(total), 0) as drawn_all from public.seed_draws
  ),
  w as (
    select coalesce(sum(amount), 0) as swept_all from public.sweeps
  ),
  t as (
    select coalesce(win, 0) as seed_win, coalesce(daily, 0) as seed_daily, coalesce(total, 0) as seed_total
    from (select 1) x left join public.seed_draws d on d.day = (p_now at time zone 'UTC')::date
  )
  select c.gross_24h, c.gross_today, c.player_share_24h, m.weighted_24h_milli,
         c.player_share_all + s.drawn_all - p.sent_all - w.swept_all,
         p.sent_last_hour, p.sent_today, p.outstanding,
         t.seed_win, t.seed_daily, t.seed_total
  from c, m, p, s, w, t;
$$;
comment on function public.treasury_window(timestamptz) is 'The ledger figures the worker recomputes the pool from (service_role).';

-- Wins on a closed UTC day per address, flagged wallets left out, best first.
create function public.daily_ranking(p_day date)
returns table (address text, wins integer)
language sql
stable
set search_path = ''
as $$
  select m.winner, count(*)::integer as wins
  from public.matches m
  join public.players pl on pl.address = m.winner
  where m.winner is not null and not pl.flagged
    and m.ended_at >= (p_day::timestamp at time zone 'UTC')
    and m.ended_at <  ((p_day + 1)::timestamp at time zone 'UTC')
  group by m.winner
  order by wins desc, m.winner;
$$;

-- The closed day's pool and its rewards, in one transaction; a second call
-- for the same day changes nothing. Rewards: [{rank, address, wins, share_bps, amount}].
create function public.book_daily(p_day date, p_gross numeric, p_seed_part numeric, p_pool numeric, p_rewards jsonb)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  r record;
  v_payout uuid;
  v_n integer := 0;
begin
  if exists (select 1 from public.daily_pools where day = p_day) then
    return -1;
  end if;
  for r in select * from jsonb_to_recordset(p_rewards) as x(rank smallint, address text, wins integer, share_bps integer, amount numeric)
  loop
    insert into public.payouts (kind, idem_key, day, rank, to_address, amount, usd)
    values ('daily', 'daily:' || to_char(p_day, 'YYYY-MM-DD') || ':' || r.rank, p_day, r.rank, r.address, r.amount,
            coalesce((select round(r.amount / power(10::numeric, decimals) * price_usd, 4) from public.pool_state), 0))
    returning id into v_payout;
    insert into public.daily_rewards (day, rank, address, wins, pool, share_bps, amount, payout_id)
    values (p_day, r.rank, r.address, r.wins, p_pool, r.share_bps, r.amount, v_payout);
    v_n := v_n + 1;
  end loop;
  insert into public.daily_pools (day, gross, seed_part, pool, rewards) values (p_day, p_gross, p_seed_part, p_pool, v_n);
  return v_n;
end
$$;

-- Today's seed draw, once; takes it off the seed's remaining balance.
create function public.book_seed_draw(p_day date, p_win numeric, p_daily numeric, p_shortfall numeric, p_sig text)
returns boolean
language plpgsql
set search_path = ''
as $$
begin
  if exists (select 1 from public.seed_draws where day = p_day) then
    return false;
  end if;
  insert into public.seed_draws (day, win, daily, total, shortfall, sig) values (p_day, p_win, p_daily, p_win + p_daily, p_shortfall, p_sig);
  update public.seed set remaining = remaining - (p_win + p_daily), updated_at = now();
  return true;
end
$$;

-- Sammy tops the seed up (/admin): both figures rise, so the 1/14 rule follows.
create function public.seed_topup(p_amount numeric)
returns void
language sql
set search_path = ''
as $$
  update public.seed set original = original + p_amount, remaining = remaining + p_amount, updated_at = now();
$$;

-- A username claimed with a signed message (the game server verifies the
-- signature and the nonce first). Case-insensitive uniqueness comes from the
-- index; the caller maps 23505 to "taken".
create function public.claim_username(p_address text, p_username text, p_sig text)
returns void
language sql
set search_path = ''
as $$
  insert into public.players as pl (address, username, username_sig)
  values (p_address, p_username, p_sig)
  on conflict (address) do update set username = excluded.username, username_sig = excluded.username_sig, last_seen = now();
$$;

-- record_match, Phase 3: the payout is booked in the same transaction as the
-- result. The game server passes the paid tier (the lower of the two), the
-- quality multiplier, the IP / fingerprint hashes and any bot flag; the
-- function applies the per-wallet caps (40 paid wins a day per address, IP
-- or fingerprint; 10 paid matches a day against the same opponent), the
-- wallet flag, and books what pool_state says the tier pays. A flagged
-- match's payout is booked but held (deferred until /admin clears or voids
-- it). Returns both players' ratings and, on the winner's row, the payout
-- booked and why it is what it is.
drop function public.record_match(uuid, text, timestamptz, timestamptz, text, text, text, text, text, text, jsonb, text, text, real, real);
create function public.record_match(
  p_id              uuid,
  p_region          text,
  p_started_at      timestamptz,
  p_ended_at        timestamptz,
  p_p1              text,
  p_p2              text,
  p_tier1           text,
  p_tier2           text,
  p_winner          text,
  p_reason          text,
  p_rounds          jsonb,
  p_input_log       text,
  p_result_hash     text,
  p_net_quality_p1  real,
  p_net_quality_p2  real,
  p_tier_paid       text default null,
  p_quality_bps     smallint default null,
  p_p1_ip_hash      text default null,
  p_p2_ip_hash      text default null,
  p_p1_fp           text default null,
  p_p2_fp           text default null,
  p_flag            text default null
) returns table (address text, elo_before integer, elo_after integer, payout numeric, payout_reason text)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_r1 integer;
  v_r2 integer;
  v_score numeric;
  v_d integer;
  v_new uuid;
  v_loser text;
  v_win_ip text;
  v_win_fp text;
  v_day_start timestamptz;
  v_wins integer;
  v_vs integer;
  v_amount numeric := 0;
  v_reason text;
  v_flagged boolean;
  v_price numeric;
  v_decimals smallint;
begin
  insert into public.players as pl (address, tier)
  select v.address, v.tier from (values (p_p1, p_tier1), (p_p2, p_tier2)) as v(address, tier) order by v.address
  on conflict (address) do update set last_seen = now(), tier = coalesce(pl.tier, excluded.tier);

  perform 1 from public.players pl where pl.address in (p_p1, p_p2) order by pl.address for update;
  select pl.elo into v_r1 from public.players pl where pl.address = p_p1;
  select pl.elo into v_r2 from public.players pl where pl.address = p_p2;

  if p_winner is null then
    v_reason := 'draw';
  elsif p_tier_paid is null then
    v_reason := 'open';
  else
    v_loser := case when p_winner = p_p1 then p_p2 else p_p1 end;
    v_win_ip := case when p_winner = p_p1 then p_p1_ip_hash else p_p2_ip_hash end;
    v_win_fp := case when p_winner = p_p1 then p_p1_fp else p_p2_fp end;
    v_day_start := date_trunc('day', p_ended_at, 'UTC');
    select pl.flagged into v_flagged from public.players pl where pl.address = p_winner;
    -- Paid wins today by this wallet, or from this IP or fingerprint.
    select count(*) into v_wins from public.matches m
    where m.payout > 0 and m.ended_at >= v_day_start and m.ended_at < v_day_start + interval '1 day'
      and (m.winner = p_winner
        or (v_win_ip is not null and ((m.winner = m.p1 and m.p1_ip_hash = v_win_ip) or (m.winner = m.p2 and m.p2_ip_hash = v_win_ip)))
        or (v_win_fp is not null and ((m.winner = m.p1 and m.p1_fp = v_win_fp) or (m.winner = m.p2 and m.p2_fp = v_win_fp))));
    -- Paid matches today between these two, either way round.
    select count(*) into v_vs from public.matches m
    where m.payout > 0 and m.ended_at >= v_day_start and m.ended_at < v_day_start + interval '1 day'
      and ((m.p1 = p_winner and m.p2 = v_loser) or (m.p1 = v_loser and m.p2 = p_winner));
    select ps.price_usd, ps.decimals,
           case p_tier_paid when 'gold' then ps.win_gold when 'chrome' then ps.win_chrome else ps.win_rust end
      into v_price, v_decimals, v_amount
      from public.pool_state ps;
    if v_amount is null then
      v_amount := 0; v_reason := 'no_pool';
    elsif coalesce(p_quality_bps, 0) = 0 then
      v_amount := 0; v_reason := 'quality';
    elsif v_flagged then
      v_amount := 0; v_reason := 'flagged';
    elsif v_wins >= 40 then
      v_amount := 0; v_reason := 'cap_wins';
    elsif v_vs >= 10 then
      v_amount := 0; v_reason := 'cap_opponent';
    else
      v_amount := floor(v_amount * p_quality_bps / 10000);
      v_reason := case when v_amount > 0 then 'paid' else 'no_pool' end;
    end if;
  end if;

  insert into public.matches (
    id, p1, p2, region, started_at, ended_at, winner, reason, rounds,
    input_log, result_hash, net_quality_p1, net_quality_p2,
    tier_paid, quality_bps, payout, payout_reason, p1_ip_hash, p2_ip_hash, p1_fp, p2_fp, flag
  ) values (
    p_id, p_p1, p_p2, p_region, p_started_at, p_ended_at, p_winner, p_reason, p_rounds,
    convert_to(p_input_log, 'UTF8'), p_result_hash, p_net_quality_p1, p_net_quality_p2,
    p_tier_paid, p_quality_bps, v_amount, v_reason, p_p1_ip_hash, p_p2_ip_hash, p_p1_fp, p_p2_fp, p_flag
  )
  on conflict (id) do nothing
  returning id into v_new;

  if v_new is null then
    -- Already recorded (a retry): report the ratings and the payout as they are.
    return query
      select v.address, v.elo, v.elo, case when m.winner = v.address then m.payout else 0 end, m.payout_reason
      from (values (p_p1, v_r1), (p_p2, v_r2)) as v(address, elo) cross join public.matches m where m.id = p_id;
    return;
  end if;

  if v_amount > 0 then
    insert into public.payouts (kind, idem_key, match_id, to_address, amount, usd, status, last_error, next_attempt_at)
    values ('win', 'win:' || p_id::text, p_id, p_winner, v_amount, round(v_amount / power(10::numeric, v_decimals) * v_price, 4),
            case when p_flag is null then 'pending' else 'deferred' end,
            case when p_flag is null then null else 'review: ' || p_flag end,
            case when p_flag is null then null else 'infinity'::timestamptz end);
    if p_flag is not null then
      insert into public.abuse_events (address, kind, match_id, details)
      values (p_winner, p_flag, p_id, jsonb_build_object('payout', v_amount));
    end if;
  end if;

  v_score := case when p_winner is null then 0.5 when p_winner = p_p1 then 1 else 0 end;
  v_d := floor(32 * (v_score - 1 / (1 + power(10::numeric, (v_r2 - v_r1) / 400.0))) + 0.5)::integer;

  update public.players pl set elo = pl.elo + v_d, last_seen = now() where pl.address = p_p1;
  update public.players pl set elo = pl.elo - v_d, last_seen = now() where pl.address = p_p2;

  return query values
    (p_p1, v_r1, v_r1 + v_d, case when p_winner = p_p1 then v_amount else 0 end, v_reason),
    (p_p2, v_r2, v_r2 - v_d, case when p_winner = p_p2 then v_amount else 0 end, v_reason);
end
$$;
comment on function public.record_match(uuid, text, timestamptz, timestamptz, text, text, text, text, text, text, jsonb, text, text, real, real, text, smallint, text, text, text, text, text) is
  'Store a finished match, update both ratings and book the win payout in one transaction; idempotent on the id (game server, service_role).';

-- Public views ----------------------------------------------------------------

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
    coalesce(sum(p.amount) filter (where p.paid_at >= b.day_start), 0) as earned_today,
    coalesce(sum(p.amount) filter (where p.paid_at >= b.week_start), 0) as earned_7d,
    sum(p.amount) as earned_all,
    coalesce(sum(p.usd) filter (where p.paid_at >= b.day_start), 0) as earned_usd_today,
    sum(p.usd) as earned_usd_all
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
  coalesce(e.earned_today, 0)::numeric(40, 0)                as earned_today,
  coalesce(e.earned_7d, 0)::numeric(40, 0)                   as earned_7d,
  r.wins_all,
  r.matches_all,
  round(r.wins_all::numeric / nullif(r.matches_all, 0), 4) as win_rate_all,
  coalesce(e.earned_all, 0)::numeric(40, 0)                  as earned_all,
  coalesce(e.earned_usd_today, 0)::numeric(14, 4)            as earned_usd_today,
  coalesce(e.earned_usd_all, 0)::numeric(14, 4)              as earned_usd_all
from record r
join public.players pl on pl.address = r.address
left join earned e on e.address = r.address;
create unique index leaderboard_v_address_key on public.leaderboard_v (address);
comment on materialized view public.leaderboard_v is
  'Public standings per address (UTC day, trailing 7 days, all time), earnings in raw units and USD. Refreshed every minute.';

-- The live pool for the front page: one row, from pool_state plus all-time
-- totals. Owner's rights and security_barrier as before (anon has no table grants).
create view public.pool_v with (security_barrier = true) as
select
  s.computed_at,
  s.price_usd,
  s.decimals,
  s.win_rust,
  s.win_chrome,
  s.win_gold,
  s.per_win_budget,
  s.weighted_milli,
  s.daily_pool,
  s.gross_24h,
  s.gross_today,
  s.outstanding,
  s.detail,
  f.gross_all,
  f.player_share_all,
  f.claims_all,
  f.last_claim_at,
  p.paid_all,
  p.paid_usd_all,
  p.paid_count_all,
  p.paid_24h,
  p.paid_count_24h,
  sd.original as seed_original,
  sd.remaining as seed_remaining,
  coalesce((select (value->>'paused')::boolean from public.settings where key = 'payouts_paused'), false) as paused,
  now() as now
from (select 1) one
left join public.pool_state s on true
cross join (
  select coalesce(sum(gross), 0)::numeric(40, 0) as gross_all, coalesce(sum(player_share), 0)::numeric(40, 0) as player_share_all,
         count(*)::integer as claims_all, max(at) as last_claim_at
  from public.fee_claims
) f
cross join (
  select coalesce(sum(amount), 0)::numeric(40, 0) as paid_all, coalesce(sum(usd), 0)::numeric(14, 4) as paid_usd_all,
         count(*)::integer as paid_count_all,
         coalesce(sum(amount) filter (where paid_at > now() - interval '24 hours'), 0)::numeric(40, 0) as paid_24h,
         (count(*) filter (where paid_at > now() - interval '24 hours'))::integer as paid_count_24h
  from public.payouts where status = 'paid'
) p
cross join (select original, remaining from public.seed) sd;
comment on view public.pool_v is 'Public pool numbers for the front page: the live pool state plus all-time totals.';

-- Paid payouts for the site (result screen, front page ticker, profiles):
-- winner, amount, transaction, and the match it was for.
create view public.payouts_v with (security_barrier = true) as
select
  p.id,
  p.kind,
  p.match_id,
  p.day,
  p.rank,
  p.to_address,
  coalesce(pl.username, 'anon-' || right(p.to_address, 4)) as display_name,
  p.amount,
  p.usd,
  p.status,
  (case when p.status in ('sent', 'paid') then p.tx_sig end)::public.sol_signature as tx_sig,
  p.created_at,
  p.paid_at
from public.payouts p
join public.players pl on pl.address = p.to_address
where p.status in ('pending', 'deferred', 'sent', 'paid');
comment on view public.payouts_v is 'Public payouts (booked and paid): amount, USD at booking, transaction. Never failed or voided rows.';

-- What a closed day paid: the top 10 with their rewards, for the leaderboard page.
create view public.daily_rewards_v with (security_barrier = true) as
select
  r.day,
  r.rank,
  r.address,
  coalesce(pl.username, 'anon-' || right(r.address, 4)) as display_name,
  r.wins,
  r.pool,
  r.share_bps,
  r.amount,
  p.tx_sig,
  p.status
from public.daily_rewards r
join public.players pl on pl.address = r.address
left join public.payouts p on p.id = r.payout_id;
comment on view public.daily_rewards_v is 'Public: each closed UTC day''s top 10 and their rewards.';

revoke all on table public.leaderboard_v, public.pool_v, public.payouts_v, public.daily_rewards_v from anon, authenticated, service_role;
grant select on table public.leaderboard_v, public.pool_v, public.payouts_v, public.daily_rewards_v to anon, authenticated, service_role;
grant maintain on table public.leaderboard_v to service_role;

-- Functions: service_role only, like record_gate (the default privileges
-- already arrange it; stated for the record).
revoke all on function public.treasury_window(timestamptz) from public, anon, authenticated;
revoke all on function public.daily_ranking(date) from public, anon, authenticated;
revoke all on function public.book_daily(date, numeric, numeric, numeric, jsonb) from public, anon, authenticated;
revoke all on function public.book_seed_draw(date, numeric, numeric, numeric, text) from public, anon, authenticated;
revoke all on function public.seed_topup(numeric) from public, anon, authenticated;
revoke all on function public.claim_username(text, text, text) from public, anon, authenticated;
revoke all on function public.record_match(uuid, text, timestamptz, timestamptz, text, text, text, text, text, text, jsonb, text, text, real, real, text, smallint, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.treasury_window(timestamptz) to service_role;
grant execute on function public.daily_ranking(date) to service_role;
grant execute on function public.book_daily(date, numeric, numeric, numeric, jsonb) to service_role;
grant execute on function public.book_seed_draw(date, numeric, numeric, numeric, text) to service_role;
grant execute on function public.seed_topup(numeric) to service_role;
grant execute on function public.claim_username(text, text, text) to service_role;
grant execute on function public.record_match(uuid, text, timestamptz, timestamptz, text, text, text, text, text, text, jsonb, text, text, real, real, text, smallint, text, text, text, text, text) to service_role;
