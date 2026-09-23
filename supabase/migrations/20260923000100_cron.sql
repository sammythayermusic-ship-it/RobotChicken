-- Refresh leaderboard_v every minute with pg_cron (spec: "refreshed as a
-- materialized view every minute"), and keep pg_cron's run log from growing
-- by about 1,440 rows a day forever.
--
-- Guarded: where pg_cron is not available (PGlite in tests, plain Postgres)
-- this only raises a NOTICE. There the worker refreshes instead; service_role
-- holds MAINTAIN on leaderboard_v for that.
--
-- cron.schedule() replaces a job with the same name, so re-running is safe.
-- Jobs run as the role that scheduled them (postgres, the view's owner).
do $$
begin
  if not exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron is not available: leaderboard_v will not refresh on its own';
    return;
  end if;

  create extension if not exists pg_cron with schema pg_catalog;

  perform cron.schedule(
    'cockfight_refresh_leaderboard_v',
    '* * * * *',
    'refresh materialized view concurrently public.leaderboard_v'
  );
  perform cron.schedule(
    'cockfight_purge_cron_history',
    '17 3 * * *',
    $job$delete from cron.job_run_details where end_time < now() - interval '7 days'$job$
  );
end
$$;
