-- Lets the quota-check Edge Function read the actual Postgres database
-- size without needing a raw SQL connection — pg_database_size() isn't
-- exposed over PostgREST directly, so this wraps it as a callable RPC.
create or replace function public.get_db_size_bytes()
returns bigint
language sql
security definer
set search_path = ''
as $$
  select pg_database_size(current_database());
$$;

-- security definer needs an explicit grant; only ever called from the
-- Edge Function's service-role client, but RLS-style least-privilege
-- still applies to function EXECUTE grants.
revoke all on function public.get_db_size_bytes() from public;
grant execute on function public.get_db_size_bytes() to service_role;

-- Tracks which (metric, threshold) warnings have already been sent so a
-- daily cron check doesn't re-DM every admin the same "80% full" warning
-- every single day it stays at 80% — only fires again once usage climbs
-- past the NEXT threshold (escalating, not repetitive).
create table quota_alerts_sent (
  metric text not null,
  threshold integer not null,
  sent_at timestamptz not null default now(),
  primary key (metric, threshold)
);

alter table quota_alerts_sent enable row level security;

-- Only the service role (quota-check itself) ever touches this — nothing
-- here is meaningful to expose to clients, admin or not.
create policy "no direct access to quota_alerts_sent"
  on quota_alerts_sent for all
  using (false);
