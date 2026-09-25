-- Phase 2: the game server records gate checks and match results through two
-- functions, so each write is one round trip and one transaction.
--
-- Both are security invoker (the default): only service_role calls them, and
-- it already holds the table grants and bypasses RLS. The default privileges
-- from the init migration keep EXECUTE away from anon and authenticated.

-- Devnet has no price API for a test mint: the gate prices it at a fixed,
-- configured USD price and records that as its source.
alter table public.balance_checks drop constraint balance_checks_source_check;
alter table public.balance_checks add constraint balance_checks_source_check
  check (source in ('jupiter', 'curve', 'fixed'));

-- One gate check: the audit row, and (when the address passed) its player row
-- with the tier it passed at. Returns the player's current rating (1000 for a
-- new player, null below the gate).
create function public.record_gate(
  p_address  text,
  p_usd      numeric,
  p_tokens   numeric,
  p_decimals smallint,
  p_source   text,
  p_tier     text
) returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_elo integer;
begin
  insert into public.balance_checks (address, usd, tokens, decimals, source)
  values (p_address, p_usd, p_tokens, p_decimals, p_source);

  if p_tier is null then
    return null;
  end if;

  insert into public.players as pl (address, tier)
  values (p_address, p_tier)
  on conflict (address) do update set tier = excluded.tier, last_seen = now()
  returning pl.elo into v_elo;
  return v_elo;
end
$$;
comment on function public.record_gate(text, numeric, numeric, smallint, text, text) is
  'Gate audit row plus the player''s tier (game server, service_role). Returns the rating, null below the gate.';

-- One finished match: the matches row and both rating updates, atomically.
--
-- ELO: K = 32, draw = 0.5, rounded half up. packages/net eloUpdate() is the
-- same formula (a test keeps them equal). Idempotent on the match id: a retry
-- of an already recorded match changes nothing and returns the ratings with
-- before = after. Both player rows are locked in address order, so two
-- matches finishing at once for the same player serialize without deadlock.
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
  p_net_quality_p2  real
) returns table (address text, elo_before integer, elo_after integer)
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
begin
  -- Players normally exist from the gate; create them if not (tier kept if
  -- set). Rows are written in address order, like the lock below, so two
  -- matches finishing at once for the same pair can't deadlock.
  insert into public.players as pl (address, tier)
  select v.address, v.tier from (values (p_p1, p_tier1), (p_p2, p_tier2)) as v(address, tier) order by v.address
  on conflict (address) do update set last_seen = now(), tier = coalesce(pl.tier, excluded.tier);

  perform 1 from public.players pl where pl.address in (p_p1, p_p2) order by pl.address for update;
  select pl.elo into v_r1 from public.players pl where pl.address = p_p1;
  select pl.elo into v_r2 from public.players pl where pl.address = p_p2;

  insert into public.matches (
    id, p1, p2, region, started_at, ended_at, winner, reason, rounds,
    input_log, result_hash, net_quality_p1, net_quality_p2
  ) values (
    p_id, p_p1, p_p2, p_region, p_started_at, p_ended_at, p_winner, p_reason, p_rounds,
    convert_to(p_input_log, 'UTF8'), p_result_hash, p_net_quality_p1, p_net_quality_p2
  )
  on conflict (id) do nothing
  returning id into v_new;

  if v_new is null then
    -- Already recorded (a retry): report the ratings as they are.
    return query values (p_p1, v_r1, v_r1), (p_p2, v_r2, v_r2);
    return;
  end if;

  v_score := case when p_winner is null then 0.5 when p_winner = p_p1 then 1 else 0 end;
  v_d := floor(32 * (v_score - 1 / (1 + power(10::numeric, (v_r2 - v_r1) / 400.0))) + 0.5)::integer;

  update public.players pl set elo = pl.elo + v_d, last_seen = now() where pl.address = p_p1;
  update public.players pl set elo = pl.elo - v_d, last_seen = now() where pl.address = p_p2;

  return query values (p_p1, v_r1, v_r1 + v_d), (p_p2, v_r2, v_r2 - v_d);
end
$$;
comment on function public.record_match(uuid, text, timestamptz, timestamptz, text, text, text, text, text, text, jsonb, text, text, real, real) is
  'Store a finished match and update both ratings in one transaction; idempotent on the id (game server, service_role).';

-- Both functions are service_role only (the init migration's default
-- privileges already arrange that; this states it for the record).
revoke all on function public.record_gate(text, numeric, numeric, smallint, text, text) from public, anon, authenticated;
revoke all on function public.record_match(uuid, text, timestamptz, timestamptz, text, text, text, text, text, text, jsonb, text, text, real, real) from public, anon, authenticated;
grant execute on function public.record_gate(text, numeric, numeric, smallint, text, text) to service_role;
grant execute on function public.record_match(uuid, text, timestamptz, timestamptz, text, text, text, text, text, text, jsonb, text, text, real, real) to service_role;
