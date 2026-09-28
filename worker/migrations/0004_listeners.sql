-- Per-listener identity, captured from Telegram's own signed initData on
-- every login (handleAuth) — login_events only ever had the numeric id,
-- not a human-readable name. Used by the admin "Слушатели" list.
create table users (
  telegram_user_id integer primary key,
  first_name text,
  last_name text,
  username text,
  first_seen_at text not null,
  last_seen_at text not null
);

-- Cumulative time actually spent listening (audio genuinely playing, not
-- just the app open) — see the Worker's /api/listen/heartbeat: the client
-- pings this every 30s while playing, and each heartbeat adds the elapsed
-- time since the previous one (capped, so a missed heartbeat only ever
-- undercounts, never inflates the total from a stale gap).
create table listen_stats (
  telegram_user_id integer primary key,
  total_seconds real not null default 0,
  last_heartbeat_at text
);
