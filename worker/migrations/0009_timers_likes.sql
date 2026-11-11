-- Timers ("play this track at exactly 19:00"), announcements that air only by
-- timer (tracks.kind = 'promo'), and one like per person per track.

-- fire_at: a one-off moment (UTC ISO). minute: every day at this minute of
-- the Moscow day. Exactly one of the two is set.
create table track_timers (
  id integer primary key autoincrement,
  track_id text not null references tracks(id) on delete cascade,
  fire_at text,
  minute integer,
  created_at text not null
);

-- Which timer occurrence a planned item answers (so it is placed only once).
alter table program add column timer_at text;

-- user_key: 'tg:<telegram id>' inside Telegram, 'dev:<device id>' on the web.
create table track_likes (
  track_id text not null references tracks(id) on delete cascade,
  user_key text not null,
  created_at text not null,
  primary key (track_id, user_key)
);
create index track_likes_created on track_likes(created_at);
