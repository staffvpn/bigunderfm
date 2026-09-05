create or replace function get_server_time()
returns timestamptz
language sql
stable
as $$
  select now();
$$;

create or replace function is_current_user_admin()
returns boolean
language sql
stable
as $$
  select coalesce((auth.jwt() -> 'app_metadata' ->> 'is_admin')::boolean, false);
$$;

create or replace function radio_skip_to(target_position integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  offset_seconds numeric := 0;
begin
  if not is_current_user_admin() then
    raise exception 'not authorized';
  end if;

  select coalesce(sum(t.duration_seconds), 0) into offset_seconds
  from playlist_items p
  join tracks t on t.id = p.track_id
  where p.position < target_position and t.is_enabled = true;

  update radio_state
  set anchor_at = now() - make_interval(secs => offset_seconds),
      is_playing = true,
      paused_offset_seconds = null,
      updated_at = now()
  where id = true;
end;
$$;

create or replace function radio_pause()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  total_seconds numeric;
  elapsed numeric := 0;
begin
  if not is_current_user_admin() then
    raise exception 'not authorized';
  end if;

  select coalesce(sum(duration_seconds), 0) into total_seconds
  from tracks t join playlist_items p on p.track_id = t.id
  where t.is_enabled = true;

  if total_seconds > 0 then
    select mod(extract(epoch from (now() - anchor_at))::numeric, total_seconds)
    into elapsed
    from radio_state where id = true;
  end if;

  update radio_state
  set is_playing = false,
      paused_offset_seconds = elapsed,
      updated_at = now()
  where id = true;
end;
$$;

create or replace function radio_resume()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  resume_offset numeric;
begin
  if not is_current_user_admin() then
    raise exception 'not authorized';
  end if;

  select coalesce(paused_offset_seconds, 0) into resume_offset
  from radio_state where id = true;

  update radio_state
  set anchor_at = now() - make_interval(secs => resume_offset),
      is_playing = true,
      paused_offset_seconds = null,
      updated_at = now()
  where id = true;
end;
$$;
