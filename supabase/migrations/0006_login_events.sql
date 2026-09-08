-- Visibility into who's actually opening the Mini App and when. Telegram
-- user identity was previously only verified transiently inside
-- telegram-auth (used once to set app_metadata.is_admin, then discarded) —
-- there was no way to answer "did user X actually log in today", which
-- came up directly while debugging a listener-specific playback issue.
create table login_events (
  id bigint generated always as identity primary key,
  telegram_user_id bigint not null,
  is_admin boolean not null,
  created_at timestamptz not null default now()
);

create index login_events_telegram_user_id_idx on login_events (telegram_user_id, created_at desc);

alter table login_events enable row level security;

-- Only admins can read the log; only the service role (telegram-auth,
-- which runs with the service key) ever writes to it — never the client.
create policy "admins can read login_events"
  on login_events for select
  using (is_current_user_admin());
