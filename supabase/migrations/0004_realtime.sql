-- Supabase creates the `supabase_realtime` publication empty; tables must be
-- explicitly added or the client's `postgres_changes` subscriptions in
-- RadioScreen.tsx never receive anything.
alter publication supabase_realtime add table radio_state;
alter publication supabase_realtime add table playlist_items;
