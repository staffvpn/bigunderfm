-- D1 (SQLite) schema for BIGUNDER FM. Replaces the Supabase Postgres tables.
-- Timestamps are ISO-8601 UTC strings ('YYYY-MM-DDTHH:MM:SS.sssZ').

create table tracks (
  id text primary key,
  title text not null,
  artist text not null,
  file_path text not null,          -- key in the R2 bucket (bigunderfm-media)
  cover_path text,                  -- key in R2, under covers/
  duration_seconds real not null,
  file_size_bytes integer not null,
  is_enabled integer not null default 1,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- position is NOT unique on purpose: reorder renumbers the whole list.
create table playlist_items (
  id text primary key,
  track_id text not null references tracks(id) on delete cascade,
  position integer not null,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
create index playlist_items_position_idx on playlist_items (position);

create table settings (
  key text primary key,
  value text not null
);
insert into settings (key, value) values ('show_name', 'LOCAL SELECTS');

create table admins (
  telegram_user_id integer primary key,
  added_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create table login_events (
  id integer primary key autoincrement,
  telegram_user_id integer not null,
  is_admin integer not null,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
create index login_events_created_idx on login_events (created_at);
create index login_events_user_idx on login_events (telegram_user_id);

-- One row per minute: how many people were receiving the stream.
create table listener_samples (
  sampled_at text primary key,
  listeners integer not null
);

create table notification_log (
  id integer primary key autoincrement,
  message text not null,
  sent_count integer not null,
  failed_count integer not null,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
