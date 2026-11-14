-- Open label: artists send a demo to the bot, an admin lets it on air with one
-- tap, it plays in the nightly DEMO HOUR, and listeners' likes move it into
-- the main rotation.
create table demos (
  track_id text primary key,
  tg_user_id integer not null,
  username text,
  status text not null default 'pending',   -- 'pending' | 'demo' | 'promoted' | 'rejected'
  created_at text not null,
  decided_at text
);
create index demos_user on demos(tg_user_id, created_at);

insert or ignore into folders (id, name, kind, position) values ('show-demo', 'DEMO HOUR', 'show', 20);
insert or ignore into schedule_slots (id, folder_id, title, days, start_minute, end_minute, priority)
  values ('slot-demo', 'show-demo', 'DEMO HOUR', '1234567', 60, 120, 10);
