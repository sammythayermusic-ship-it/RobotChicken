-- The pot (Sammy, 2026-10-01): bigger wins from the first match.
--
-- A win pays its tier's share (Rust 5%, Chrome 8%, Gold 12%) of the prize pot
-- available above the reserve ($100, held once the pot has been worth $500),
-- and comes off the pot at once. The worker recomputes the pot every minute
-- from the ledger (allowance − outstanding − today's daily pool − reserve) and
-- writes it to pool_state.win_available; record_match takes each win from
-- that row under a lock. Sammy adds to the pot by hand: PUMP sent to the hot
-- wallet, then /admin → Add to prize pool (pot_topups).

create table public.pot_topups (
  id      uuid primary key default gen_random_uuid(),
  at      timestamptz not null default now(),
  amount  numeric(40, 0) not null check (amount > 0),
  note    text
);
comment on table public.pot_topups is 'PUMP Sammy added to the prize pot by hand (sent to the hot wallet first). Counts toward the allowance.';
alter table public.pot_topups enable row level security;
revoke all on table public.pot_topups from public, anon, authenticated, service_role;
grant select, insert on table public.pot_topups to service_role;

alter table public.pool_state
  add column win_available numeric(40, 0) not null default 0 check (win_available >= 0),
  add column pct_rust     integer not null default 500  check (pct_rust between 0 and 10000),
  add column pct_chrome   integer not null default 800  check (pct_chrome between 0 and 10000),
  add column pct_gold     integer not null default 1200 check (pct_gold between 0 and 10000),
  add column floor_rust   numeric(40, 0) not null default 0 check (floor_rust >= 0),
  add column floor_chrome numeric(40, 0) not null default 0 check (floor_chrome >= 0),
  add column floor_gold   numeric(40, 0) not null default 0 check (floor_gold >= 0),
  add column cap_rust     numeric(40, 0) not null default 0 check (cap_rust >= 0),
  add column cap_chrome   numeric(40, 0) not null default 0 check (cap_chrome >= 0),
  add column cap_gold     numeric(40, 0) not null default 0 check (cap_gold >= 0);

-- One tier's win from what is available (packages/economy winFrom): its share,
-- at least the floor while there is that much, at most the cap, never more than there is.
create function public.pot_win(p_available numeric, p_pct integer, p_floor numeric, p_cap numeric)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case when p_available <= 0 then 0
    else least(greatest(floor(p_available * p_pct / 10000), least(p_floor, p_available)), p_cap, p_available) end;
$$;

-- Top-ups count toward the allowance like claims and seed draws.
drop function public.treasury_window(timestamptz);
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
  u as (
    select coalesce(sum(amount), 0) as topped_all from public.pot_topups
  ),
  t as (
    select coalesce(win, 0) as seed_win, coalesce(daily, 0) as seed_daily, coalesce(total, 0) as seed_total
    from (select 1) x left join public.seed_draws d on d.day = (p_now at time zone 'UTC')::date
  )
  select c.gross_24h, c.gross_today, c.player_share_24h, m.weighted_24h_milli,
         c.player_share_all + s.drawn_all + u.topped_all - p.sent_all - w.swept_all,
         p.sent_last_hour, p.sent_today, p.outstanding,
         t.seed_win, t.seed_daily, t.seed_total
  from c, m, p, s, w, u, t;
$$;
comment on function public.treasury_window(timestamptz) is 'The ledger figures the worker recomputes the pool from (service_role).';

-- /admin's top-up now adds to the pot (the seed wallet is retired).
create or replace function public.seed_topup(p_amount numeric)
returns void
language sql
set search_path = ''
as $$
  insert into public.pot_topups (amount, note) values (p_amount, 'admin');
$$;

drop function public.record_match(uuid, text, timestamptz, timestamptz, text, text, text, text, text, text, jsonb, text, text, real, real, text, smallint, text, text, text, text, text);
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
    -- The pot (2026-10-01): the tier's share of what is available above the
    -- reserve right now, floored and capped, taken off at once (the row is
    -- locked) so the next win pays from what this one left.
    select ps.price_usd, ps.decimals,
           public.pot_win(ps.win_available,
             case p_tier_paid when 'gold' then ps.pct_gold when 'chrome' then ps.pct_chrome else ps.pct_rust end,
             case p_tier_paid when 'gold' then ps.floor_gold when 'chrome' then ps.floor_chrome else ps.floor_rust end,
             case p_tier_paid when 'gold' then ps.cap_gold when 'chrome' then ps.cap_chrome else ps.cap_rust end)
      into v_price, v_decimals, v_amount
      from public.pool_state ps
      for update;
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
    if v_amount > 0 then
      update public.pool_state ps set
        win_available = ps.win_available - v_amount,
        win_rust   = public.pot_win(ps.win_available - v_amount, ps.pct_rust,   ps.floor_rust,   ps.cap_rust),
        win_chrome = public.pot_win(ps.win_available - v_amount, ps.pct_chrome, ps.floor_chrome, ps.cap_chrome),
        win_gold   = public.pot_win(ps.win_available - v_amount, ps.pct_gold,   ps.floor_gold,   ps.cap_gold);
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
  'Stores a ranked result, both ELO updates and the winner''s payout from the pot (its tier''s share, taken off at once), atomically (service_role).';

revoke all on function public.pot_win(numeric, integer, numeric, numeric) from public, anon, authenticated;
revoke all on function public.treasury_window(timestamptz) from public, anon, authenticated;
revoke all on function public.record_match(uuid, text, timestamptz, timestamptz, text, text, text, text, text, text, jsonb, text, text, real, real, text, smallint, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.pot_win(numeric, integer, numeric, numeric) to service_role;
grant execute on function public.treasury_window(timestamptz) to service_role;
grant execute on function public.record_match(uuid, text, timestamptz, timestamptz, text, text, text, text, text, text, jsonb, text, text, real, real, text, smallint, text, text, text, text, text) to service_role;
