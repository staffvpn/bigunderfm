-- Deleted tracks wait here (with their audio kept in R2) for 14 days, so an
-- accidental delete can be undone.
create table track_trash (
  id text primary key,
  row_json text not null,
  folders_json text not null,
  position integer,
  deleted_at text not null
);
