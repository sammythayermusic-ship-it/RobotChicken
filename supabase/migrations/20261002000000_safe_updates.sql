-- Supabase runs pg-safeupdate: an UPDATE or DELETE with no WHERE clause is
-- refused ("UPDATE requires a WHERE clause"), even on a one-row table. The
-- pot's record_match (20261001000000_pot.sql) took each win off pool_state
-- with a bare UPDATE, so on 2026-10-02 the first ranked match on production
-- could not be recorded at all (no result, no ELO, no payout). PGlite, which
-- the SQL tests run on, has no safeupdate, so the tests passed.
--
-- Both one-row tables have `id boolean primary key check (id)`, so `where id`
-- (or `where ps.id`) names the row. tools/test/safeUpdate.test.ts now checks
-- the latest definition of every function for a bare UPDATE / DELETE.

create or replace function public.record_match(
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
        win_gold   = public.pot_win(ps.win_available - v_amount, ps.pct_gold,   ps.floor_gold,   ps.cap_gold)
      where ps.id;
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

create or replace function public.book_seed_draw(p_day date, p_win numeric, p_daily numeric, p_shortfall numeric, p_sig text)
returns boolean
language plpgsql
set search_path = ''
as $$
begin
  if exists (select 1 from public.seed_draws where day = p_day) then
    return false;
  end if;
  insert into public.seed_draws (day, win, daily, total, shortfall, sig) values (p_day, p_win, p_daily, p_win + p_daily, p_shortfall, p_sig);
  update public.seed set remaining = remaining - (p_win + p_daily), updated_at = now() where id;
  return true;
end
$$;
