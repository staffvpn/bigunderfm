-- The admin-editable show name displayed on the radio screen (default
-- "LOCAL SELECTS", the tagline it originally shipped with). Lives on the
-- existing radio_state singleton row rather than a new table — the RLS
-- policies already on that table (public read, admin write) cover this
-- column too with no new policy needed.
alter table radio_state add column show_name text not null default 'LOCAL SELECTS';
