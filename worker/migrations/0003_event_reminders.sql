-- Listeners can subscribe to a bot reminder for an upcoming event ("Напомнить"
-- button on the Schedule card). The cron in index.ts's scheduled() sends the
-- actual reminder message once the event is close, then marks it sent.
create table event_reminders (
  event_id text not null,
  telegram_user_id integer not null,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  notified_at text,
  primary key (event_id, telegram_user_id)
);

create index event_reminders_pending_idx on event_reminders (notified_at);
