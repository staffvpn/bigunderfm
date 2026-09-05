insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('tracks', 'tracks', true, 20971520, array['audio/mpeg', 'audio/mp4', 'audio/wav']),
  ('covers', 'covers', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create policy "public read tracks bucket" on storage.objects
  for select using (bucket_id = 'tracks');

create policy "admin write tracks bucket" on storage.objects
  for all using (
    bucket_id = 'tracks' and (auth.jwt() -> 'app_metadata' ->> 'is_admin')::boolean = true
  )
  with check (
    bucket_id = 'tracks' and (auth.jwt() -> 'app_metadata' ->> 'is_admin')::boolean = true
  );

create policy "public read covers bucket" on storage.objects
  for select using (bucket_id = 'covers');

create policy "admin write covers bucket" on storage.objects
  for all using (
    bucket_id = 'covers' and (auth.jwt() -> 'app_metadata' ->> 'is_admin')::boolean = true
  )
  with check (
    bucket_id = 'covers' and (auth.jwt() -> 'app_metadata' ->> 'is_admin')::boolean = true
  );
