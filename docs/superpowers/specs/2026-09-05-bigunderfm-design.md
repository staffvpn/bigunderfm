# BIGUNDER FM — Design Spec

Date: 2026-09-05
Status: approved by user, ready for implementation planning

## 1. Overview

BIGUNDER FM is an underground internet-radio Telegram Mini App. The admin
uploads tracks; the app plays them as one continuous, shared radio channel
— every listener hears (approximately) the same thing at the same time,
with automatic track-to-track advance. No manual track picking.

Hard constraints from the product owner:
- Must run **entirely free** — no paid VPS, no paid worker process.
- Frontend hosted on **Cloudflare Pages**.
- Backend on **Supabase** (Postgres + Storage + Realtime + Edge Functions),
  Free plan.
- Admin panel lives **inside the same Mini App** (hidden tab, gated by
  Telegram user ID allowlist) — not a separate site.
- Visual identity: dark underground aesthetic with graffiti accents
  (spray textures, stickers/tags as UI accents), not a SaaS dashboard look.

## 2. Goals / Non-goals

**Goals**
- Synchronized shared "radio" feel across all listeners, with zero
  ongoing server cost.
- Trivial upload workflow for the admin (drop files, metadata
  auto-extracted, no manual field-filling when tags exist).
- Small, maintainable, modular codebase.

**Explicitly deferred (not in this build)**
- True sample-accurate gapless streaming (Icecast/HLS/ffmpeg pipeline).
- Multiple stations, genres, scheduling, DJ sets, jingles/ad breaks.
- Shuffle, track history, likes/favorites, track requests.
- External/public web player, Discord/Telegram notifications.
- Rate limiting beyond Supabase defaults (single small admin surface;
  add if abuse is observed).

The data model and RPC boundary are deliberately kept simple enough that
any of the above can be layered on later without a rewrite.

## 3. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | React + TypeScript + Vite | fast, standard, plays well with Cloudflare Pages |
| Hosting (frontend) | Cloudflare Pages | free static hosting, auto-deploy from GitHub |
| Telegram integration | Telegram WebApp JS SDK | official Mini App bridge (`initData`, theme, viewport) |
| Backend | Supabase (Postgres, Storage, Realtime, Edge Functions) | free tier covers DB + object storage + realtime + one small function, no server to run ourselves |
| Metadata extraction | `music-metadata-browser` (client-side) | reads ID3 tags / duration in the browser, no server-side ffmpeg needed |

No custom server process is ever run. There is no ffmpeg/Icecast pipeline
in this build.

## 4. The core mechanic: Virtual Synced Timeline

There is no continuous audio stream muxed on a server. Instead, every
client computes the same "what's playing right now" answer from shared,
deterministic data:

- `radio_state` (single row) stores `anchor_at` (timestamptz), `is_playing`,
  `paused_offset_seconds`, `playlist_version`.
- The playlist is an ordered, looping list of tracks with known durations.
- Any client computes:
  ```
  elapsed = (server_now - anchor_at) mod total_playlist_duration
  walk playlist, summing durations, until the cumulative sum exceeds elapsed
  → that track is "current"; (elapsed - sum_before_it) is the seek offset
  ```
- On load, the client seeks its `<audio>` element to that offset and plays.
- The client's own timer predicts the next boundary and swaps `src` to the
  next track locally, preloading it slightly ahead of time — no server
  round-trip needed for ordinary track-to-track advance.
- `server_now` is fetched once per session (via a Postgres `now()` RPC
  call, not the client's own clock) and used to compute a local
  clock-offset; the client re-syncs against this periodically to correct
  drift, and always re-syncs after a Realtime event.

Admin actions never touch `anchor_at` directly from client-computed time.
They call **Postgres RPC functions** (`SECURITY DEFINER`) that use the
database's own `now()`:

- `radio_skip_to(track_position)` — recomputes `anchor_at` so the formula
  above immediately lands on the requested track.
- `radio_pause()` — sets `is_playing = false`, records
  `paused_offset_seconds` computed from `now()`.
- `radio_resume()` — sets `anchor_at = now() - paused_offset_seconds`,
  `is_playing = true`.
- Playlist edits (add/remove/reorder) bump `playlist_version` and, for
  MVP simplicity, take effect from the **next loop pass** — they do not
  retroactively shift the currently-playing track. Only an explicit SKIP
  changes what's playing immediately. This avoids surprising jumps when
  the admin is just reordering the tail of the list.

**Trade-offs, stated plainly:** the transition between tracks is not a
sample-accurate crossfade — there's a small (sub-second on a CDN) gap
while the next file starts playing. There's no external stream URL for
third-party players; that's out of scope. Clock drift is bounded by
periodic resync but not physically eliminated. If a true gapless stream
is ever needed, it can be added later as an alternate playback source
(e.g. an Icecast/HLS worker on a small always-on host) without changing
the data model.

### Restart / cold-start behavior

There is no server process, so there's nothing to "restart." `anchor_at`
is just a timestamp; the formula above is correct from any point in time,
including after long downtime (the loop simply appears to have "moved on"
— equivalent to tuning into a real radio station after being away).

One real caveat: **Supabase's free plan pauses a project after about 7
days with zero API activity.** If the admin disappears for a week with no
one opening the app, the project pauses and needs a manual "Restore" click
in the Supabase dashboard (or a trivial scheduled ping to prevent it).
This is a known limitation of the free tier, not a bug in this design.

## 5. Data model (Postgres, via Supabase)

```sql
tracks (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  artist text not null,
  file_path text not null,        -- path within the "tracks" storage bucket
  cover_path text,                -- path within the "covers" storage bucket
  duration_seconds numeric not null,
  file_size_bytes bigint not null,
  is_enabled boolean not null default true,
  created_at timestamptz not null default now()
)

playlist_items (
  id uuid primary key default gen_random_uuid(),
  track_id uuid not null references tracks(id) on delete cascade,
  position integer not null,
  created_at timestamptz not null default now(),
  unique (position)
)
-- This single ordered list IS the playlist and the queue for MVP;
-- a separate "queue" entity is unnecessary duplication (YAGNI).

radio_state (
  id boolean primary key default true check (id),  -- singleton row trick
  anchor_at timestamptz not null default now(),
  is_playing boolean not null default false,
  paused_offset_seconds numeric,
  playlist_version integer not null default 1,
  updated_at timestamptz not null default now()
)

admins (
  telegram_user_id bigint primary key,
  added_at timestamptz not null default now()
)
```

Listener count is **not** a database table — it's tracked via a Supabase
Realtime **Presence** channel (ephemeral, in-memory, free, no writes).

## 6. Storage

Two Supabase Storage buckets:
- `tracks` — public read, admin-only write. MIME allowlist: `audio/mpeg`,
  `audio/mp4`, `audio/wav`. Size cap enforced both client-side (reject
  before upload) and via bucket policy (e.g. 20MB/file).
- `covers` — public read, admin-only write. Image MIME allowlist
  (`image/jpeg`, `image/png`, `image/webp`).

Public read means no signed URLs are needed for playback — simplest
option, acceptable since this is not sensitive content.

## 7. Auth & security

- Telegram Mini App sends `initData` on load.
- One Edge Function, **`telegram-auth`**: validates the `initData` HMAC
  signature using the bot token (stored as a Supabase secret, never sent
  to the client), looks up the Telegram user id in `admins`, and mints a
  Supabase JWT carrying an `is_admin` claim (true/false).
- Row-Level Security:
  - `tracks` / `playlist_items` / `radio_state`: public `SELECT`
    (`is_enabled = true` filter for tracks); `INSERT`/`UPDATE`/`DELETE`
    require `(auth.jwt() ->> 'is_admin')::boolean = true`.
  - Storage buckets: mirrored — public read, admin-only write.
- All radio-state mutations go through the `SECURITY DEFINER` RPCs from
  §4, not raw table writes, so the timeline math stays consistent.
- No custom rate limiting in MVP — the only writable surface is
  admin-gated, and Supabase applies its own baseline abuse protection.
  Revisit if the admin allowlist ever grows.

## 8. Key flows

**Track upload (admin)**
1. Admin opens the hidden "Library" tab (visible only when
   `telegram-auth` returned `is_admin: true`).
2. Selects one or many audio files.
3. For each file, the browser extracts title/artist/embedded cover/duration
   via `music-metadata-browser`; admin can edit any field before confirming.
4. File uploads directly from the browser to the `tracks` bucket (and
   cover to `covers`) using the admin's Supabase session — RLS enforces
   admin-only write.
5. A row is inserted into `tracks`; the admin then places it into the
   playlist (or it's auto-appended at the end, admin can reorder after).
6. UI shows a per-file result list (success/failure).

**New listener joins**
1. Mini App loads, calls `telegram-auth` with `initData`.
2. Fetches `radio_state` + `playlist_items` joined with `tracks` +
   database `now()`.
3. Computes current track + offset (§4), seeks `<audio>`, plays if
   `is_playing`.
4. Subscribes to Realtime changes on `radio_state`/`playlist_items` and
   joins the presence channel (for listener count).

**Ordinary track-to-track switch**
- Fully client-side: a local timer (derived from the synced clock) fires
  at the computed track boundary, swaps `<audio>` src to the pre-fetched
  next track, and updates the "now playing" UI. No network call required.

**Admin control (skip / pause / resume / reorder)**
1. Admin taps a control in the Radio tab.
2. Client calls the matching Postgres RPC (§4) via the Supabase client
   (JWT carries `is_admin`).
3. RPC recomputes `anchor_at`/`is_playing` using DB `now()`.
4. Postgres change fires a Realtime event; all connected clients receive
   it and immediately recompute/resync — no polling.

## 9. Frontend structure

```
bigunderfm/
  src/
    screens/
      RadioScreen.tsx        -- main listener screen (LIVE, cover, progress, play/pause, next)
      AdminLibrary.tsx        -- upload / edit / delete / reorder tracks
      AdminRadioControls.tsx  -- play/pause/skip, current+next track, listener count
    lib/
      telegram.ts             -- WebApp SDK init, initData access
      supabase.ts             -- Supabase client init
      radioClock.ts           -- timeline math: computeCurrentPosition(playlist, radio_state, serverNow)
      metadata.ts             -- client-side tag/duration extraction
    components/
      Player, CoverArt, ProgressBar, TrackList, UploadDropzone, OnAirBadge, GraffitiAccents...
    styles/
      theme (dark palette, concrete/noise texture, spray-accent assets)
  supabase/
    functions/telegram-auth/index.ts
    migrations/
      0001_init.sql            -- tables, RLS policies
      0002_radio_rpc.sql        -- radio_skip_to / radio_pause / radio_resume
  docs/
    superpowers/specs/          -- this file and future specs
```

## 10. MVP scope

**User (Telegram Mini App)**
- Single main screen: station name, ON AIR indicator, cover, artist/title,
  progress bar, big play/pause, "next" preview, subtle on-air animation.
- Continuous, looping, auto-advancing playback via the virtual timeline.
- Telegram auth on load (`initData` validated server-side).

**Admin (hidden tab in the same Mini App, allowlisted Telegram IDs)**
- Upload one or many tracks with client-side metadata auto-fill.
- Edit title/artist/cover, enable/disable, delete, drag-and-drop reorder.
- Radio controls: play/pause/skip, view current + next track, listener count.

**Backend**
- Postgres schema + RLS (§5–§7).
- Storage buckets with policy + MIME/size limits.
- `telegram-auth` Edge Function.
- Radio RPC functions.
- Realtime subscriptions for state sync + Presence for listener count.

Everything under "Explicitly deferred" (§2) is out of scope for this pass.

## 11. Visual design direction

Dark underground base with graffiti accents, not full street-art mural and
not a generic SaaS look:
- Near-black / dark-grey background, subtle concrete/noise texture.
- Bold, condensed/grotesque display type for track title & artist.
- Spray-paint textures, sticker/tag-style elements used sparingly as
  accents — logo mark, ON AIR badge, buttons — not covering the whole UI.
- One or two neon/high-contrast accent colors against black; everything
  else desaturated.
- One primary screen, minimal navigation (admin tab hidden unless
  authorized) — no dashboard chrome, no extra menus.

## 12. Deployment

- **Cloudflare Pages**: connect the `staffvpn/bigunderfm` GitHub repo,
  build command `npm run build`, output `dist/`, env vars
  `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.
- **Supabase**: new free-tier project; run migrations; deploy
  `telegram-auth` function with secret `TELEGRAM_BOT_TOKEN`; seed the
  `admins` table with the owner's Telegram user id.
- **Telegram**: BotFather → create bot (owner's task) → set Mini App URL
  to the Cloudflare Pages domain.

## 13. Known risks / caveats

- Supabase free-tier project auto-pauses after ~7 days of zero API
  activity — needs a manual restore click or a periodic keep-alive ping.
- Free-tier egress (~5GB/month) caps how much traffic the station can
  serve; encode tracks at a moderate bitrate (128kbps mp3) rather than
  lossless, to stretch this.
- Track transitions have a small (sub-second, connection-dependent) gap
  — not a sample-accurate crossfade.
- Synchronization is "close," not sample-accurate, across listeners —
  acceptable for the underground-radio feel this product wants, not
  acceptable if broadcast-grade sync is ever required (would need §4's
  noted future Icecast/HLS path).
