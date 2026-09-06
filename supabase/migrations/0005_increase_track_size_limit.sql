-- 20MB was too tight for real-world uploads (e.g. a longer or
-- higher-bitrate mp3/wav) — a real admin upload hit "The object exceeded
-- the maximum allowed size" the first time someone tried a bigger file.
-- 50MB stays within the Supabase free plan's per-object limit.
update storage.buckets set file_size_limit = 52428800 where id = 'tracks';
