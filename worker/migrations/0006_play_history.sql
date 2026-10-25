-- What played on air, for the listeners' "что играло" list. The minute cron
-- adds a row whenever the stream title changes; only the last 100 are kept.
create table if not exists play_history (
  id integer primary key autoincrement,
  title text not null,
  played_at text not null
);
