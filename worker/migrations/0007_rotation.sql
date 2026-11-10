-- Autorotation: folders by mood, a weekly grid of slots, hits, jingles and
-- the on-air log the Worker plans ahead (see src/rotation.ts, src/program.ts).

-- 'jingle' rows are station idents: never part of a folder's music, played
-- between tracks every few songs.
alter table tracks add column kind text not null default 'track';
-- Marked by an admin; hits come round every few hours instead of once per rotation.
alter table tracks add column is_hit integer not null default 0;

update tracks set kind = 'jingle' where upper(trim(title)) like 'JINGLE%';

create table folders (
  id text primary key,
  name text not null,
  kind text not null default 'mood',   -- 'mood' (day part) | 'show'
  position integer not null default 0
);

create table folder_tracks (
  folder_id text not null references folders(id) on delete cascade,
  track_id text not null references tracks(id) on delete cascade,
  primary key (folder_id, track_id)
);
create index folder_tracks_track on folder_tracks(track_id);

-- When a folder is on air. Times are minutes of the Moscow day; a slot whose
-- end is before its start runs past midnight. days: weekdays it starts on,
-- digits 1 (Monday) .. 7 (Sunday). The highest priority slot covering "now"
-- whose folder has tracks wins, so an empty show folder just doesn't air.
create table schedule_slots (
  id text primary key,
  folder_id text not null references folders(id) on delete cascade,
  title text not null,
  days text not null default '1234567',
  start_minute integer not null,
  end_minute integer not null,
  priority integer not null default 0
);

-- What goes on air, planned about an hour ahead by the minute cron. While
-- the VPS is down the app plays exactly this timeline from R2; when it is up
-- the same picks are pushed into Liquidsoap's queue. Also the play history
-- the rotation uses to avoid repeats.
create table program (
  id integer primary key autoincrement,
  track_id text not null,
  starts_at text not null,
  ends_at text not null,
  kind text not null,                  -- 'track' | 'hit' | 'new' | 'jingle'
  slot_title text not null default ''
);
create index program_starts on program(starts_at);
create index program_track on program(track_id, starts_at);

-- Hearts listeners sent while a track was on air, per day (auto-hits).
create table track_hearts (
  track_id text not null,
  day text not null,
  hearts integer not null default 0,
  primary key (track_id, day)
);

insert into folders (id, name, kind, position) values
  ('morning', 'Утро', 'mood', 1),
  ('day', 'День', 'mood', 2),
  ('evening', 'Вечер', 'mood', 3),
  ('night', 'Ночь', 'mood', 4),
  ('show-good-morning', 'GOOD MORNING CLUB', 'show', 5),
  ('show-b-side', 'B SIDE SHOW', 'show', 6),
  ('show-no-sleep', 'NO SLEEP CLUB', 'show', 7);

insert into schedule_slots (id, folder_id, title, days, start_minute, end_minute, priority) values
  ('slot-morning', 'morning', 'УТРО', '1234567', 360, 660, 0),
  ('slot-day', 'day', 'ДЕНЬ', '1234567', 660, 1020, 0),
  ('slot-evening', 'evening', 'ВЕЧЕР', '1234567', 1020, 1380, 0),
  ('slot-night', 'night', 'НОЧЬ', '1234567', 1380, 360, 0),
  ('slot-good-morning', 'show-good-morning', 'GOOD MORNING CLUB', '67', 600, 660, 10),
  ('slot-b-side', 'show-b-side', 'B SIDE SHOW', '2', 1140, 1200, 10),
  ('slot-no-sleep', 'show-no-sleep', 'NO SLEEP CLUB', '5', 1140, 1200, 10);
