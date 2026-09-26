-- Schedule of upcoming events (parties, shows, guest mixes) — shown to
-- listeners on their own "Schedule" tab, and used to trigger the "event
-- soon" ticker on the Эфир/Live screen. Admin-managed (create/edit/delete),
-- see worker/src/index.ts's /api/admin/events routes.
create table events (
  id text primary key,
  title text not null,
  description text not null default '',
  event_at text not null,           -- ISO 8601 UTC — when the event happens
  image_path text,                  -- R2 key under events/, or null
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create index events_event_at_idx on events (event_at);
