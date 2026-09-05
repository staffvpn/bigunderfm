create extension if not exists pgcrypto;

create table tracks (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  artist text not null,
  file_path text not null,
  cover_path text,
  duration_seconds numeric not null,
  file_size_bytes bigint not null,
  is_enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create table playlist_items (
  id uuid primary key default gen_random_uuid(),
  track_id uuid not null references tracks(id) on delete cascade,
  -- Not UNIQUE: the admin UI renumbers the *entire* list to 1..N on every
  -- reorder via sequential single-row UPDATEs, which would collide with a
  -- UNIQUE constraint on virtually any real reorder (the new position for
  -- row A is often still held by row B until B's own update runs a moment
  -- later). Ordering only ever reads via ORDER BY position, and any
  -- transient duplicate self-heals as soon as the renumbering loop finishes.
  position integer not null,
  created_at timestamptz not null default now()
);

create table radio_state (
  id boolean primary key default true check (id),
  anchor_at timestamptz not null default now(),
  is_playing boolean not null default false,
  paused_offset_seconds numeric,
  playlist_version integer not null default 1,
  updated_at timestamptz not null default now()
);

insert into radio_state (id) values (true);

create table admins (
  telegram_user_id bigint primary key,
  added_at timestamptz not null default now()
);

alter table tracks enable row level security;
alter table playlist_items enable row level security;
alter table radio_state enable row level security;
alter table admins enable row level security;

create policy "public read enabled tracks" on tracks
  for select using (is_enabled = true);

create policy "admin write tracks" on tracks
  for all using ((auth.jwt() -> 'app_metadata' ->> 'is_admin')::boolean = true)
  with check ((auth.jwt() -> 'app_metadata' ->> 'is_admin')::boolean = true);

create policy "public read playlist" on playlist_items
  for select using (true);

create policy "admin write playlist" on playlist_items
  for all using ((auth.jwt() -> 'app_metadata' ->> 'is_admin')::boolean = true)
  with check ((auth.jwt() -> 'app_metadata' ->> 'is_admin')::boolean = true);

create policy "public read radio state" on radio_state
  for select using (true);

create policy "admin write radio state" on radio_state
  for all using ((auth.jwt() -> 'app_metadata' ->> 'is_admin')::boolean = true)
  with check ((auth.jwt() -> 'app_metadata' ->> 'is_admin')::boolean = true);

create policy "no direct access to admins" on admins
  for all using (false);
