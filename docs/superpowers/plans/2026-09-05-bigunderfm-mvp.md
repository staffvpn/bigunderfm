# BIGUNDER FM MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a working Telegram Mini App underground radio (BIGUNDER FM) — synchronized shared playback via a virtual timeline, admin controls inside the same app, fully on free-tier Cloudflare Pages + Supabase.

**Architecture:** React+TS SPA (Cloudflare Pages) reads/writes Supabase Postgres directly via RLS; a single Edge Function validates Telegram `initData` and flags admins; radio "current track" is computed client-side from a shared `anchor_at` timestamp instead of a real audio stream. No custom server process exists anywhere.

**Tech Stack:** Vite, React 18, TypeScript, Vitest, `@supabase/supabase-js`, `music-metadata-browser`, Supabase (Postgres/Storage/Realtime/Edge Functions/Deno), Telegram WebApp JS SDK.

**Spec:** `docs/superpowers/specs/2026-09-05-bigunderfm-design.md`

## Global Constraints

- Must run entirely on free tiers — no paid VPS, no paid always-on worker process.
- Frontend hosted on Cloudflare Pages; backend is Supabase only (Postgres + Storage + Realtime + Edge Functions).
- Admin UI lives inside the same Mini App (hidden nav, gated by `is_admin`), not a separate site.
- No ffmpeg/Icecast/HLS pipeline in this build — playback sync is achieved via the virtual-timeline formula in the spec §4.
- Visual identity: dark background, bold display type, graffiti/spray accents used sparingly — not a SaaS dashboard look.
- Pure logic (`radioClock.ts`, `metadata.ts`) is TDD'd with Vitest; UI wiring is verified by typecheck + build, not exhaustive component tests (YAGNI for this pass).

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.node.json`
- Create: `vite.config.ts`
- Create: `index.html`
- Create: `src/main.tsx`
- Create: `src/styles/theme.css`
- Create: `.env.example`
- Create: `.gitignore`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: a running Vite dev server, `npm test` (vitest) runnable, `App` component slot at `src/App.tsx` (created in Task 11) rendered from `src/main.tsx`.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "bigunderfm",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "typecheck": "tsc -b --noEmit"
  },
  "dependencies": {
    "@supabase/supabase-js": "^2.45.0",
    "music-metadata-browser": "^2.5.10",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@types/react": "^18.3.3",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.1",
    "typescript": "^5.5.3",
    "vite": "^5.4.0",
    "vitest": "^2.0.5"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true
  },
  "include": ["src"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```

- [ ] **Step 3: Write `tsconfig.node.json`**

```json
{
  "compilerOptions": {
    "composite": true,
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowSyntheticDefaultImports": true
  },
  "include": ["vite.config.ts"]
}
```

- [ ] **Step 4: Write `vite.config.ts`**

```ts
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    globals: true,
  },
})
```

- [ ] **Step 5: Write `index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <title>BIGUNDER FM</title>
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 6: Write `src/main.tsx`**

```tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/theme.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
```

- [ ] **Step 7: Write `src/styles/theme.css`**

```css
:root {
  --color-bg: #0a0a0a;
  --color-surface: #161616;
  --color-text: #f2f2f0;
  --color-muted: #8a8a86;
  --color-accent: #d6ff3f;
  --color-accent-2: #ff2e63;
  --font-display: 'Arial Narrow', 'Helvetica Neue Condensed', sans-serif;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--color-bg);
  color: var(--color-text);
  font-family: var(--font-display);
  background-image:
    radial-gradient(circle at 20% 20%, rgba(214, 255, 63, 0.04), transparent 40%),
    radial-gradient(circle at 80% 60%, rgba(255, 46, 99, 0.05), transparent 40%);
}

.app-loading {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-muted);
  letter-spacing: 2px;
  text-transform: uppercase;
}
```

- [ ] **Step 8: Write `.env.example`**

```
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
```

- [ ] **Step 9: Write `.gitignore`**

```
node_modules
dist
.env
.env.local
```

- [ ] **Step 10: Install dependencies and verify the dev server boots**

Run: `npm install`
Run: `npm run typecheck` (will fail: `src/App.tsx` does not exist yet)
Expected: `error TS... Cannot find module './App'` — this is expected until Task 11; confirm the error is exactly this missing-module error and nothing else (i.e. config itself is valid).

- [ ] **Step 11: Commit**

```bash
git add package.json tsconfig.json tsconfig.node.json vite.config.ts index.html src/main.tsx src/styles/theme.css .env.example .gitignore
git commit -m "chore: scaffold Vite+React+TS project"
```

---

### Task 2: Radio timeline logic (`radioClock.ts`)

**Files:**
- Create: `src/lib/radioClock.ts`
- Test: `src/lib/radioClock.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (used by Task 8's `RadioScreen`):
  - `interface PlaylistTrack { trackId: string; durationSeconds: number }`
  - `interface RadioState { anchorAt: string; isPlaying: boolean; pausedOffsetSeconds: number | null }`
  - `interface RadioPosition { trackIndex: number; trackId: string; offsetSeconds: number }`
  - `function totalDuration(playlist: PlaylistTrack[]): number`
  - `function computeCurrentPosition(playlist: PlaylistTrack[], radioState: RadioState, serverNow: Date): RadioPosition | null`
  - `function secondsUntilNextBoundary(playlist: PlaylistTrack[], position: RadioPosition): number`

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/radioClock.test.ts
import { describe, expect, it } from 'vitest'
import { computeCurrentPosition, secondsUntilNextBoundary, totalDuration } from './radioClock'

const playlist = [
  { trackId: 'a', durationSeconds: 100 },
  { trackId: 'b', durationSeconds: 200 },
  { trackId: 'c', durationSeconds: 150 },
]

describe('totalDuration', () => {
  it('sums track durations', () => {
    expect(totalDuration(playlist)).toBe(450)
  })
})

describe('computeCurrentPosition', () => {
  it('returns the first track at elapsed 0', () => {
    const now = new Date('2026-01-01T00:00:00Z')
    const state = { anchorAt: now.toISOString(), isPlaying: true, pausedOffsetSeconds: null }
    const pos = computeCurrentPosition(playlist, state, now)
    expect(pos).toEqual({ trackIndex: 0, trackId: 'a', offsetSeconds: 0 })
  })

  it('returns the correct offset inside the second track', () => {
    const anchor = new Date('2026-01-01T00:00:00Z')
    const now = new Date(anchor.getTime() + 150_000) // 150s elapsed: 100s into track a done, 50s into b
    const state = { anchorAt: anchor.toISOString(), isPlaying: true, pausedOffsetSeconds: null }
    const pos = computeCurrentPosition(playlist, state, now)
    expect(pos).toEqual({ trackIndex: 1, trackId: 'b', offsetSeconds: 50 })
  })

  it('loops back to the first track after the total duration', () => {
    const anchor = new Date('2026-01-01T00:00:00Z')
    const now = new Date(anchor.getTime() + 460_000) // 450s total + 10s into the next loop
    const state = { anchorAt: anchor.toISOString(), isPlaying: true, pausedOffsetSeconds: null }
    const pos = computeCurrentPosition(playlist, state, now)
    expect(pos).toEqual({ trackIndex: 0, trackId: 'a', offsetSeconds: 10 })
  })

  it('uses pausedOffsetSeconds when not playing', () => {
    const state = { anchorAt: new Date().toISOString(), isPlaying: false, pausedOffsetSeconds: 120 }
    const pos = computeCurrentPosition(playlist, state, new Date())
    expect(pos).toEqual({ trackIndex: 1, trackId: 'b', offsetSeconds: 20 })
  })

  it('returns null for an empty playlist', () => {
    const state = { anchorAt: new Date().toISOString(), isPlaying: true, pausedOffsetSeconds: null }
    expect(computeCurrentPosition([], state, new Date())).toBeNull()
  })
})

describe('secondsUntilNextBoundary', () => {
  it('returns the remaining seconds in the current track', () => {
    const pos = { trackIndex: 1, trackId: 'b', offsetSeconds: 50 }
    expect(secondsUntilNextBoundary(playlist, pos)).toBe(150)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- radioClock`
Expected: FAIL — `radioClock.ts` does not exist yet.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/radioClock.ts
export interface PlaylistTrack {
  trackId: string
  durationSeconds: number
}

export interface RadioState {
  anchorAt: string
  isPlaying: boolean
  pausedOffsetSeconds: number | null
}

export interface RadioPosition {
  trackIndex: number
  trackId: string
  offsetSeconds: number
}

export function totalDuration(playlist: PlaylistTrack[]): number {
  return playlist.reduce((sum, t) => sum + t.durationSeconds, 0)
}

export function computeCurrentPosition(
  playlist: PlaylistTrack[],
  radioState: RadioState,
  serverNow: Date,
): RadioPosition | null {
  if (playlist.length === 0) return null

  if (!radioState.isPlaying) {
    return positionAtElapsed(playlist, radioState.pausedOffsetSeconds ?? 0)
  }

  const total = totalDuration(playlist)
  if (total <= 0) return null

  const anchorMs = new Date(radioState.anchorAt).getTime()
  const rawElapsedSeconds = (serverNow.getTime() - anchorMs) / 1000
  const elapsed = ((rawElapsedSeconds % total) + total) % total

  return positionAtElapsed(playlist, elapsed)
}

function positionAtElapsed(playlist: PlaylistTrack[], elapsed: number): RadioPosition {
  let cumulative = 0
  for (let i = 0; i < playlist.length; i++) {
    const track = playlist[i]
    if (elapsed < cumulative + track.durationSeconds) {
      return { trackIndex: i, trackId: track.trackId, offsetSeconds: elapsed - cumulative }
    }
    cumulative += track.durationSeconds
  }
  const last = playlist[playlist.length - 1]
  return { trackIndex: playlist.length - 1, trackId: last.trackId, offsetSeconds: last.durationSeconds }
}

export function secondsUntilNextBoundary(playlist: PlaylistTrack[], position: RadioPosition): number {
  return playlist[position.trackIndex].durationSeconds - position.offsetSeconds
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- radioClock`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/radioClock.ts src/lib/radioClock.test.ts
git commit -m "feat: add virtual radio timeline logic"
```

---

### Task 3: Client-side metadata extraction (`metadata.ts`)

**Files:**
- Create: `src/lib/metadata.ts`
- Test: `src/lib/metadata.test.ts`

**Interfaces:**
- Consumes: `music-metadata-browser`'s `parseBlob`.
- Produces (used by Task 9's `AdminLibrary`):
  - `interface ExtractedMetadata { title: string; artist: string; durationSeconds: number; coverBlob: Blob | null }`
  - `function extractTrackMetadata(file: File): Promise<ExtractedMetadata>`

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/metadata.test.ts
import { describe, expect, it, vi } from 'vitest'

vi.mock('music-metadata-browser', () => ({
  parseBlob: vi.fn(),
}))

import { parseBlob } from 'music-metadata-browser'
import { extractTrackMetadata } from './metadata'

function makeFile(name: string): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'audio/mpeg' })
}

describe('extractTrackMetadata', () => {
  it('uses tag data when present', async () => {
    vi.mocked(parseBlob).mockResolvedValueOnce({
      common: { title: 'Night Drive', artist: 'DJ Concrete', picture: undefined },
      format: { duration: 214.5 },
    } as any)

    const result = await extractTrackMetadata(makeFile('01-track.mp3'))

    expect(result).toEqual({
      title: 'Night Drive',
      artist: 'DJ Concrete',
      durationSeconds: 214.5,
      coverBlob: null,
    })
  })

  it('falls back to filename and defaults when tags are missing', async () => {
    vi.mocked(parseBlob).mockResolvedValueOnce({
      common: {},
      format: {},
    } as any)

    const result = await extractTrackMetadata(makeFile('warehouse session.mp3'))

    expect(result.title).toBe('warehouse session')
    expect(result.artist).toBe('Unknown Artist')
    expect(result.durationSeconds).toBe(0)
    expect(result.coverBlob).toBeNull()
  })

  it('falls back gracefully when parsing throws', async () => {
    vi.mocked(parseBlob).mockRejectedValueOnce(new Error('corrupt file'))

    const result = await extractTrackMetadata(makeFile('broken.mp3'))

    expect(result.title).toBe('broken')
    expect(result.artist).toBe('Unknown Artist')
  })

  it('extracts an embedded cover picture as a Blob', async () => {
    vi.mocked(parseBlob).mockResolvedValueOnce({
      common: {
        title: 'Cover Test',
        artist: 'Artist',
        picture: [{ data: new Uint8Array([9, 9, 9]), format: 'image/jpeg' }],
      },
      format: { duration: 100 },
    } as any)

    const result = await extractTrackMetadata(makeFile('cover.mp3'))

    expect(result.coverBlob).toBeInstanceOf(Blob)
    expect(result.coverBlob?.type).toBe('image/jpeg')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- metadata`
Expected: FAIL — `metadata.ts` does not exist yet.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/metadata.ts
import { parseBlob } from 'music-metadata-browser'

export interface ExtractedMetadata {
  title: string
  artist: string
  durationSeconds: number
  coverBlob: Blob | null
}

export async function extractTrackMetadata(file: File): Promise<ExtractedMetadata> {
  const fallbackTitle = stripExtension(file.name)

  try {
    const metadata = await parseBlob(file)
    const picture = metadata.common.picture?.[0]

    return {
      title: metadata.common.title?.trim() || fallbackTitle,
      artist: metadata.common.artist?.trim() || 'Unknown Artist',
      durationSeconds: metadata.format.duration ?? 0,
      coverBlob: picture ? new Blob([picture.data], { type: picture.format }) : null,
    }
  } catch {
    return {
      title: fallbackTitle,
      artist: 'Unknown Artist',
      durationSeconds: 0,
      coverBlob: null,
    }
  }
}

function stripExtension(filename: string): string {
  const lastDot = filename.lastIndexOf('.')
  return lastDot > 0 ? filename.slice(0, lastDot) : filename
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- metadata`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/metadata.ts src/lib/metadata.test.ts
git commit -m "feat: add client-side track metadata extraction"
```

---

### Task 4: Supabase SQL migrations

**Files:**
- Create: `supabase/migrations/0001_init.sql`
- Create: `supabase/migrations/0002_radio_rpc.sql`
- Create: `supabase/migrations/0003_storage.sql`

**Interfaces:**
- Consumes: nothing.
- Produces (used by Task 6's provisioning and Task 7's data layer): tables `tracks`, `playlist_items`, `radio_state`, `admins`; RPCs `get_server_time()`, `is_current_user_admin()`, `radio_skip_to(target_position integer)`, `radio_pause()`, `radio_resume()`; storage buckets `tracks`, `covers`.

- [ ] **Step 1: Write `supabase/migrations/0001_init.sql`**

```sql
create extension if not exists pgcrypto;

create table tracks (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  artist text not null,
  file_path text not null,
  cover_path text,
  duration_seconds numeric not null,
  file_size_bytes bigint not null,
  is_enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create table playlist_items (
  id uuid primary key default gen_random_uuid(),
  track_id uuid not null references tracks(id) on delete cascade,
  -- Not UNIQUE: the admin UI renumbers the *entire* list to 1..N on every
  -- reorder via sequential single-row UPDATEs, which would collide with a
  -- UNIQUE constraint on virtually any real reorder (the new position for
  -- row A is often still held by row B until B's own update runs a moment
  -- later). Ordering only ever reads via ORDER BY position, and any
  -- transient duplicate self-heals as soon as the renumbering loop finishes.
  position integer not null,
  created_at timestamptz not null default now()
);

create table radio_state (
  id boolean primary key default true check (id),
  anchor_at timestamptz not null default now(),
  is_playing boolean not null default false,
  paused_offset_seconds numeric,
  playlist_version integer not null default 1,
  updated_at timestamptz not null default now()
);

insert into radio_state (id) values (true);

create table admins (
  telegram_user_id bigint primary key,
  added_at timestamptz not null default now()
);

alter table tracks enable row level security;
alter table playlist_items enable row level security;
alter table radio_state enable row level security;
alter table admins enable row level security;

create policy "public read enabled tracks" on tracks
  for select using (is_enabled = true);

create policy "admin write tracks" on tracks
  for all using ((auth.jwt() -> 'app_metadata' ->> 'is_admin')::boolean = true)
  with check ((auth.jwt() -> 'app_metadata' ->> 'is_admin')::boolean = true);

create policy "public read playlist" on playlist_items
  for select using (true);

create policy "admin write playlist" on playlist_items
  for all using ((auth.jwt() -> 'app_metadata' ->> 'is_admin')::boolean = true)
  with check ((auth.jwt() -> 'app_metadata' ->> 'is_admin')::boolean = true);

create policy "public read radio state" on radio_state
  for select using (true);

create policy "admin write radio state" on radio_state
  for all using ((auth.jwt() -> 'app_metadata' ->> 'is_admin')::boolean = true)
  with check ((auth.jwt() -> 'app_metadata' ->> 'is_admin')::boolean = true);

create policy "no direct access to admins" on admins
  for all using (false);
```

- [ ] **Step 2: Write `supabase/migrations/0002_radio_rpc.sql`**

```sql
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
  where p.position < target_position;

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
  from tracks t join playlist_items p on p.track_id = t.id;

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
```

- [ ] **Step 3: Write `supabase/migrations/0003_storage.sql`**

```sql
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
```

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations
git commit -m "feat: add Supabase schema, RLS, and radio RPC migrations"
```

---

### Task 5: `telegram-auth` Edge Function

**Files:**
- Create: `supabase/functions/telegram-auth/index.ts`

**Interfaces:**
- Consumes: `admins` table (Task 4), env vars `TELEGRAM_BOT_TOKEN`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`; the caller's own Supabase session token via the standard `Authorization: Bearer <token>` header (Supabase's client SDK attaches this automatically on `functions.invoke` calls made after `signInAnonymously()` — no manual wiring needed).
- Produces (used by Task 7's `auth.ts`): an HTTP endpoint accepting `POST { initData: string }` (no client-supplied user id — the caller's identity is derived server-side from their own session token, so a caller can never assert admin for an account that isn't their own), responding `{ isAdmin: boolean }`, and — as a side effect when `isAdmin` is true — setting `app_metadata.is_admin = true` on the Supabase auth user that the `Authorization` header authenticates as. Also rejects `initData` whose `auth_date` is older than 24 hours, bounding how long a leaked/captured `initData` string stays usable as a replay.

- [ ] **Step 1: Write `supabase/functions/telegram-auth/index.ts`**

```ts
import { createClient } from 'jsr:@supabase/supabase-js@2'

const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const MAX_INIT_DATA_AGE_SECONDS = 86400 // 24 hours

async function hmacSha256(key: BufferSource, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data))
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

async function verifyInitData(
  initData: string,
  botToken: string,
): Promise<{ valid: boolean; telegramUserId: number | null }> {
  const params = new URLSearchParams(initData)
  const hash = params.get('hash')
  if (!hash) return { valid: false, telegramUserId: null }
  params.delete('hash')

  const authDate = Number(params.get('auth_date'))
  if (!authDate || Date.now() / 1000 - authDate > MAX_INIT_DATA_AGE_SECONDS) {
    return { valid: false, telegramUserId: null }
  }

  const dataCheckString = Array.from(params.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')

  const secretKey = await hmacSha256(new TextEncoder().encode('WebAppData'), botToken)
  const computedHash = toHex(await hmacSha256(secretKey, dataCheckString))

  if (computedHash !== hash) {
    return { valid: false, telegramUserId: null }
  }

  const userJson = params.get('user')
  const telegramUserId = userJson ? JSON.parse(userJson).id : null
  return { valid: true, telegramUserId }
}

Deno.serve(async (req) => {
  try {
    const { initData } = await req.json()

    if (!initData) {
      return new Response(JSON.stringify({ error: 'initData is required' }), { status: 400 })
    }

    const authHeader = req.headers.get('Authorization') ?? ''
    const accessToken = authHeader.replace(/^Bearer\s+/i, '')
    if (!accessToken) {
      return new Response(JSON.stringify({ error: 'missing Authorization header' }), { status: 401 })
    }

    const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

    const { data: callerData, error: callerError } = await adminClient.auth.getUser(accessToken)
    if (callerError || !callerData.user) {
      return new Response(JSON.stringify({ error: 'invalid session' }), { status: 401 })
    }
    const userId = callerData.user.id

    const { valid, telegramUserId } = await verifyInitData(initData, BOT_TOKEN)
    if (!valid || !telegramUserId) {
      return new Response(JSON.stringify({ isAdmin: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const { data: adminRow } = await adminClient
      .from('admins')
      .select('telegram_user_id')
      .eq('telegram_user_id', telegramUserId)
      .maybeSingle()

    const isAdmin = Boolean(adminRow)

    if (isAdmin) {
      await adminClient.auth.admin.updateUserById(userId, {
        app_metadata: { is_admin: true },
      })
    }

    return new Response(JSON.stringify({ isAdmin }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error(err)
    return new Response(JSON.stringify({ error: 'internal error' }), { status: 500 })
  }
})
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/telegram-auth/index.ts
git commit -m "feat: add telegram-auth edge function"
```

---

### Task 6: Provision the live Supabase project

**Files:** none (infrastructure task — uses the Supabase MCP tools already connected in this session).

**Interfaces:**
- Consumes: migration files from Task 4, edge function from Task 5.
- Produces: a live Supabase project; its `project_url` and `anon_key` (needed for Task 7's `.env.local`, not committed).

- [ ] **Step 1: Create the project**

Use the Supabase MCP tool to create a new project named `bigunderfm` in the `nichegotakova` organization (id `elbjuqrqrvnidjqnraqd`) on the free plan, in a low-latency region. Call `confirm_cost` first if the tool requires it, then `create_project`. Record the returned `project_id`.

- [ ] **Step 2: Apply the migrations in order**

Apply `supabase/migrations/0001_init.sql`, then `0002_radio_rpc.sql`, then `0003_storage.sql` via the `apply_migration` tool, in that exact order (0002's functions reference tables from 0001; 0003's bucket policies reference the same `is_admin` claim pattern).

- [ ] **Step 3: Verify the schema**

Call `list_tables` and confirm `tracks`, `playlist_items`, `radio_state`, `admins` all exist with RLS enabled. Call `get_advisors` (security) and resolve any high-severity finding before moving on (e.g. a missed RLS-enable step).

- [ ] **Step 4: Deploy the edge function**

Deploy `supabase/functions/telegram-auth` via `deploy_edge_function`. Note in the task output that `TELEGRAM_BOT_TOKEN` must still be set as a function secret once the user creates their bot (this cannot happen yet — no bot exists) — flag this clearly as a manual follow-up, do not treat it as a task failure.

- [ ] **Step 5: Capture connection details**

Call `get_project_url` and `get_publishable_keys`. Write them to a local `.env.local` file (NOT committed — it's covered by `.gitignore`) in this exact format:

```
VITE_SUPABASE_URL=<project_url>
VITE_SUPABASE_ANON_KEY=<anon_key>
```

- [ ] **Step 6: Report**

Summarize in the task's final message: project id, project URL, confirmation that all 3 migrations applied cleanly, confirmation the edge function deployed, and the outstanding manual step (setting `TELEGRAM_BOT_TOKEN` once BotFather issues one, and seeding the `admins` table with the owner's Telegram user id). No commit — nothing in this task touches tracked files.

---

### Task 7: Data & auth layer

**Files:**
- Create: `src/lib/supabase.ts`
- Create: `src/lib/telegram.ts`
- Create: `src/lib/auth.ts`
- Create: `src/lib/tracks.ts`

**Interfaces:**
- Consumes: `PlaylistTrack` from `src/lib/radioClock.ts` (Task 2); live project env vars from Task 6.
- Produces (used by Tasks 8–10):
  - `supabase.ts`: `export const supabase: SupabaseClient`
  - `telegram.ts`: `getTelegramWebApp()`, `getInitData(): string`, `initTelegramApp(): void`
  - `auth.ts`: `interface AuthResult { isAdmin: boolean }`, `async function authenticate(): Promise<AuthResult>`
  - `tracks.ts`: `interface Track`, `interface PlaylistEntry { position: number; track: Track }`, `interface RadioStateRow`, `trackPublicUrl(filePath: string): string`, `coverPublicUrl(coverPath: string | null): string | null`, `async function fetchPlaylist(): Promise<PlaylistEntry[]>`, `toPlaylistTracks(entries: PlaylistEntry[]): PlaylistTrack[]`, `async function fetchRadioState(): Promise<RadioStateRow | null>`, `async function fetchServerNow(): Promise<Date>`

- [ ] **Step 1: Write `src/lib/supabase.ts`**

```ts
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY env vars')
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey)
```

- [ ] **Step 2: Write `src/lib/telegram.ts`**

```ts
interface TelegramWebApp {
  initData: string
  initDataUnsafe: Record<string, unknown>
  ready: () => void
  expand: () => void
  colorScheme: 'light' | 'dark'
}

declare global {
  interface Window {
    Telegram?: { WebApp: TelegramWebApp }
  }
}

export function getTelegramWebApp(): TelegramWebApp | null {
  return window.Telegram?.WebApp ?? null
}

export function getInitData(): string {
  const webApp = getTelegramWebApp()
  return webApp?.initData ?? ''
}

export function initTelegramApp(): void {
  const webApp = getTelegramWebApp()
  if (webApp) {
    webApp.ready()
    webApp.expand()
  }
}
```

- [ ] **Step 3: Write `src/lib/auth.ts`**

```ts
import { supabase } from './supabase'
import { getInitData } from './telegram'

export interface AuthResult {
  isAdmin: boolean
}

export async function authenticate(): Promise<AuthResult> {
  const initData = getInitData()
  if (!initData) {
    return { isAdmin: false }
  }

  const { error: signInError } = await supabase.auth.signInAnonymously()
  if (signInError) {
    console.error('anonymous sign-in failed', signInError)
    return { isAdmin: false }
  }

  // No userId in the body: telegram-auth derives the caller's identity from
  // the Authorization header supabase-js attaches automatically from the
  // session just created above — a caller can never assert admin for an
  // account that isn't its own.
  const { data, error } = await supabase.functions.invoke('telegram-auth', {
    body: { initData },
  })

  if (error || !data) {
    console.error('telegram-auth failed', error)
    return { isAdmin: false }
  }

  if (data.isAdmin) {
    await supabase.auth.refreshSession()
  }

  return { isAdmin: Boolean(data.isAdmin) }
}
```

- [ ] **Step 4: Write `src/lib/tracks.ts`**

```ts
import { supabase } from './supabase'
import type { PlaylistTrack } from './radioClock'

export interface Track {
  id: string
  title: string
  artist: string
  filePath: string
  coverPath: string | null
  durationSeconds: number
  fileSizeBytes: number
  isEnabled: boolean
}

export interface PlaylistEntry {
  position: number
  track: Track
}

export function trackPublicUrl(filePath: string): string {
  return supabase.storage.from('tracks').getPublicUrl(filePath).data.publicUrl
}

export function coverPublicUrl(coverPath: string | null): string | null {
  if (!coverPath) return null
  return supabase.storage.from('covers').getPublicUrl(coverPath).data.publicUrl
}

export async function fetchPlaylist(): Promise<PlaylistEntry[]> {
  const { data, error } = await supabase
    .from('playlist_items')
    .select(
      'position, tracks!inner(id, title, artist, file_path, cover_path, duration_seconds, file_size_bytes, is_enabled)',
    )
    .order('position', { ascending: true })

  if (error || !data) {
    console.error('fetchPlaylist failed', error)
    return []
  }

  return (data as any[])
    .filter((row) => row.tracks.is_enabled)
    .map((row) => ({
      position: row.position,
      track: {
        id: row.tracks.id,
        title: row.tracks.title,
        artist: row.tracks.artist,
        filePath: row.tracks.file_path,
        coverPath: row.tracks.cover_path,
        durationSeconds: Number(row.tracks.duration_seconds),
        fileSizeBytes: Number(row.tracks.file_size_bytes),
        isEnabled: row.tracks.is_enabled,
      },
    }))
}

export function toPlaylistTracks(entries: PlaylistEntry[]): PlaylistTrack[] {
  return entries.map((e) => ({ trackId: e.track.id, durationSeconds: e.track.durationSeconds }))
}

export interface RadioStateRow {
  anchorAt: string
  isPlaying: boolean
  pausedOffsetSeconds: number | null
  playlistVersion: number
}

export async function fetchRadioState(): Promise<RadioStateRow | null> {
  const { data, error } = await supabase
    .from('radio_state')
    .select('anchor_at, is_playing, paused_offset_seconds, playlist_version')
    .eq('id', true)
    .maybeSingle()

  if (error || !data) {
    console.error('fetchRadioState failed', error)
    return null
  }

  return {
    anchorAt: data.anchor_at,
    isPlaying: data.is_playing,
    pausedOffsetSeconds: data.paused_offset_seconds,
    playlistVersion: data.playlist_version,
  }
}

export async function fetchServerNow(): Promise<Date> {
  const { data, error } = await supabase.rpc('get_server_time')
  if (error || !data) {
    console.error('fetchServerNow failed', error)
    return new Date()
  }
  return new Date(data)
}
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: only the still-missing `src/App.tsx` error remains (fixed in Task 11).

- [ ] **Step 6: Commit**

```bash
git add src/lib/supabase.ts src/lib/telegram.ts src/lib/auth.ts src/lib/tracks.ts
git commit -m "feat: add Supabase client, Telegram bridge, auth, and track data layer"
```

---

### Task 8: Radio screen (listener UI)

**Files:**
- Create: `src/components/OnAirBadge.tsx`
- Create: `src/components/ProgressBar.tsx`
- Create: `src/components/CoverArt.tsx`
- Create: `src/screens/RadioScreen.tsx`
- Modify: `src/styles/theme.css` (append radio-screen styles)

**Interfaces:**
- Consumes: `computeCurrentPosition`, `secondsUntilNextBoundary` (Task 2); `supabase`, `fetchPlaylist`, `fetchRadioState`, `fetchServerNow`, `toPlaylistTracks`, `trackPublicUrl`, `coverPublicUrl`, `PlaylistEntry` (Task 7).
- Produces (used by Task 11's `App.tsx`): `export function RadioScreen(): JSX.Element`.

- [ ] **Step 1: Write `src/components/OnAirBadge.tsx`**

```tsx
interface OnAirBadgeProps {
  isPlaying: boolean
}

export function OnAirBadge({ isPlaying }: OnAirBadgeProps) {
  return (
    <div className={`on-air-badge ${isPlaying ? 'on-air-badge--live' : ''}`}>
      <span className="on-air-badge__dot" />
      {isPlaying ? 'ON AIR' : 'OFF AIR'}
    </div>
  )
}
```

- [ ] **Step 2: Write `src/components/ProgressBar.tsx`**

```tsx
interface ProgressBarProps {
  offsetSeconds: number
  durationSeconds: number
}

export function ProgressBar({ offsetSeconds, durationSeconds }: ProgressBarProps) {
  const percent = durationSeconds > 0 ? Math.min(100, (offsetSeconds / durationSeconds) * 100) : 0

  return (
    <div className="progress-bar">
      <div className="progress-bar__track">
        <div className="progress-bar__fill" style={{ width: `${percent}%` }} />
      </div>
      <div className="progress-bar__time">
        <span>{formatTime(offsetSeconds)}</span>
        <span>{formatTime(durationSeconds)}</span>
      </div>
    </div>
  )
}

function formatTime(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(safe / 60)
  const remainder = safe % 60
  return `${minutes}:${remainder.toString().padStart(2, '0')}`
}
```

- [ ] **Step 3: Write `src/components/CoverArt.tsx`**

```tsx
interface CoverArtProps {
  coverUrl: string | null
  alt: string
}

export function CoverArt({ coverUrl, alt }: CoverArtProps) {
  return (
    <div className="cover-art">
      {coverUrl ? (
        <img src={coverUrl} alt={alt} className="cover-art__image" />
      ) : (
        <div className="cover-art__placeholder">BIGUNDER FM</div>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Write `src/screens/RadioScreen.tsx`**

```tsx
import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { computeCurrentPosition, secondsUntilNextBoundary, type RadioPosition } from '../lib/radioClock'
import {
  fetchPlaylist,
  fetchRadioState,
  fetchServerNow,
  toPlaylistTracks,
  trackPublicUrl,
  coverPublicUrl,
  type PlaylistEntry,
} from '../lib/tracks'
import { OnAirBadge } from '../components/OnAirBadge'
import { ProgressBar } from '../components/ProgressBar'
import { CoverArt } from '../components/CoverArt'

export function RadioScreen() {
  const [entries, setEntries] = useState<PlaylistEntry[]>([])
  const [position, setPosition] = useState<RadioPosition | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [listenerCount, setListenerCount] = useState(1)
  const [userStarted, setUserStarted] = useState(false)
  const [isPaused, setIsPaused] = useState(true)
  const audioRef = useRef<HTMLAudioElement>(null)
  const advanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const entriesRef = useRef<PlaylistEntry[]>([])
  // hasInteractedRef/isPausedRef (not the userStarted/isPaused state above) are
  // what applyPositionToAudio actually reads. The mount-only effect below
  // captures resync/applyPositionToAudio/scheduleNextAdvance exactly once, so
  // any *state* they read stays frozen at its value from that first render
  // forever — reading `userStarted` state here would always see `false`,
  // silently auto-pausing playback on every later resync. Refs don't have
  // this problem: the closures still hold a stable reference to the same
  // ref object, and `.current` always reflects the latest value. The
  // `userStarted`/`isPaused` state above exists purely so the button can
  // re-render — calling their setters from inside the frozen closures is
  // fine; it's only *reading* state there that would be stale.
  const hasInteractedRef = useRef(false)
  const isPausedRef = useRef(true)

  useEffect(() => {
    entriesRef.current = entries
  }, [entries])

  async function resync() {
    const [playlist, radioState, serverNow] = await Promise.all([
      fetchPlaylist(),
      fetchRadioState(),
      fetchServerNow(),
    ])

    setEntries(playlist)
    setIsPlaying(radioState?.isPlaying ?? false)
    if (!radioState) return

    const tracks = toPlaylistTracks(playlist)
    const pos = computeCurrentPosition(
      tracks,
      {
        anchorAt: radioState.anchorAt,
        isPlaying: radioState.isPlaying,
        pausedOffsetSeconds: radioState.pausedOffsetSeconds,
      },
      serverNow,
    )

    setPosition(pos)
    applyPositionToAudio(pos, radioState.isPlaying, playlist)
    scheduleNextAdvance(tracks, pos, radioState.isPlaying)
  }

  function applyPositionToAudio(pos: RadioPosition | null, playing: boolean, playlist: PlaylistEntry[]) {
    const audio = audioRef.current
    if (!audio || !pos) return

    const entry = playlist[pos.trackIndex]
    if (!entry) return

    const url = trackPublicUrl(entry.track.filePath)
    if (audio.src !== url) {
      audio.src = url
    }
    audio.currentTime = pos.offsetSeconds
    if (playing && hasInteractedRef.current && !isPausedRef.current) {
      audio.play().catch(() => {})
    } else {
      audio.pause()
    }
  }

  function scheduleNextAdvance(
    tracks: ReturnType<typeof toPlaylistTracks>,
    pos: RadioPosition | null,
    playing: boolean,
  ) {
    if (advanceTimerRef.current) clearTimeout(advanceTimerRef.current)
    if (!pos || !playing || tracks.length === 0) return

    const remaining = secondsUntilNextBoundary(tracks, pos)
    advanceTimerRef.current = setTimeout(() => resync(), Math.max(250, remaining * 1000))
  }

  useEffect(() => {
    resync()

    const channel = supabase
      .channel('radio-room')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'radio_state' }, resync)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'playlist_items' }, resync)
      .on('presence', { event: 'sync' }, () => {
        setListenerCount(Math.max(1, Object.keys(channel.presenceState()).length))
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await channel.track({ joined_at: new Date().toISOString() })
        }
      })

    return () => {
      supabase.removeChannel(channel)
      if (advanceTimerRef.current) clearTimeout(advanceTimerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function handlePlayClick() {
    const audio = audioRef.current
    if (!audio) return

    if (!hasInteractedRef.current) {
      hasInteractedRef.current = true
      isPausedRef.current = false
      setUserStarted(true)
      setIsPaused(false)
      audio.play().catch(() => {})
      return
    }

    const nextPaused = !isPausedRef.current
    isPausedRef.current = nextPaused
    setIsPaused(nextPaused)
    if (nextPaused) {
      audio.pause()
    } else {
      audio.play().catch(() => {})
    }
  }

  const currentEntry = position ? entries[position.trackIndex] : undefined
  const nextEntry = position && entries.length > 0 ? entries[(position.trackIndex + 1) % entries.length] : undefined

  return (
    <div className="radio-screen">
      <div className="radio-screen__header">
        <span className="radio-screen__station">BIGUNDER FM</span>
        <OnAirBadge isPlaying={isPlaying} />
      </div>

      <CoverArt
        coverUrl={currentEntry ? coverPublicUrl(currentEntry.track.coverPath) : null}
        alt={currentEntry?.track.title ?? 'BIGUNDER FM'}
      />

      <div className="radio-screen__track-info">
        <div className="radio-screen__artist">{currentEntry?.track.artist ?? '—'}</div>
        <div className="radio-screen__title">{currentEntry?.track.title ?? 'Tune in...'}</div>
      </div>

      <ProgressBar
        offsetSeconds={position?.offsetSeconds ?? 0}
        durationSeconds={currentEntry?.track.durationSeconds ?? 0}
      />

      <button className="radio-screen__play" onClick={handlePlayClick}>
        {userStarted && !isPaused ? '❚❚' : '▶'}
      </button>

      {nextEntry && (
        <div className="radio-screen__next">
          NEXT: {nextEntry.track.artist} — {nextEntry.track.title}
        </div>
      )}

      <div className="radio-screen__listeners">{listenerCount} listening</div>

      <audio ref={audioRef} />
    </div>
  )
}
```

- [ ] **Step 5: Append radio-screen styles to `src/styles/theme.css`**

```css
.radio-screen {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  padding: 24px 16px 40px;
}

.radio-screen__header {
  width: 100%;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.radio-screen__station {
  font-size: 22px;
  font-weight: 800;
  letter-spacing: 2px;
  text-transform: uppercase;
  text-shadow: 2px 2px 0 var(--color-accent-2);
}

.on-air-badge {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border: 1px solid var(--color-muted);
  border-radius: 999px;
  font-size: 12px;
  letter-spacing: 1px;
}

.on-air-badge__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-muted);
}

.on-air-badge--live {
  border-color: var(--color-accent);
  color: var(--color-accent);
}

.on-air-badge--live .on-air-badge__dot {
  background: var(--color-accent);
  box-shadow: 0 0 8px var(--color-accent);
}

.cover-art {
  width: min(70vw, 280px);
  aspect-ratio: 1;
  border-radius: 8px;
  overflow: hidden;
  background: var(--color-surface);
  border: 2px solid #262626;
}

.cover-art__image {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.cover-art__placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 800;
  color: var(--color-muted);
  text-align: center;
  padding: 12px;
}

.radio-screen__track-info {
  text-align: center;
}

.radio-screen__artist {
  color: var(--color-muted);
  text-transform: uppercase;
  font-size: 14px;
  letter-spacing: 1px;
}

.radio-screen__title {
  font-size: 24px;
  font-weight: 800;
}

.progress-bar {
  width: 100%;
  max-width: 320px;
}

.progress-bar__track {
  height: 4px;
  background: var(--color-surface);
  border-radius: 2px;
  overflow: hidden;
}

.progress-bar__fill {
  height: 100%;
  background: var(--color-accent);
}

.progress-bar__time {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: var(--color-muted);
  margin-top: 4px;
}

.radio-screen__play {
  width: 72px;
  height: 72px;
  border-radius: 50%;
  border: 2px solid var(--color-accent);
  background: transparent;
  color: var(--color-accent);
  font-size: 28px;
  cursor: pointer;
}

.radio-screen__next,
.radio-screen__listeners {
  color: var(--color-muted);
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 1px;
}
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: only the still-missing `src/App.tsx` error remains (fixed in Task 11).

- [ ] **Step 7: Commit**

```bash
git add src/components/OnAirBadge.tsx src/components/ProgressBar.tsx src/components/CoverArt.tsx src/screens/RadioScreen.tsx src/styles/theme.css
git commit -m "feat: add radio listener screen"
```

---

### Task 9: Admin library screen

**Files:**
- Create: `src/screens/AdminLibrary.tsx`
- Modify: `src/styles/theme.css` (append admin styles)

**Interfaces:**
- Consumes: `supabase` (Task 7), `extractTrackMetadata` (Task 3), `fetchPlaylist`, `PlaylistEntry` (Task 7).
- Produces (used by Task 11's `App.tsx`): `export function AdminLibrary(): JSX.Element`.

- [ ] **Step 1: Write `src/screens/AdminLibrary.tsx`**

```tsx
import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { extractTrackMetadata } from '../lib/metadata'
import { fetchPlaylist, type PlaylistEntry } from '../lib/tracks'

export function AdminLibrary() {
  const [entries, setEntries] = useState<PlaylistEntry[]>([])
  const [uploading, setUploading] = useState(false)
  const [results, setResults] = useState<string[]>([])

  async function reload() {
    setEntries(await fetchPlaylist())
  }

  useEffect(() => {
    reload()
  }, [])

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return
    setUploading(true)
    const log: string[] = []

    const { data: existing } = await supabase
      .from('playlist_items')
      .select('position')
      .order('position', { ascending: false })
      .limit(1)
    let nextPosition = (existing?.[0]?.position ?? 0) + 1

    for (const file of Array.from(files)) {
      try {
        const meta = await extractTrackMetadata(file)
        const filePath = `${crypto.randomUUID()}-${file.name}`

        const { error: uploadError } = await supabase.storage.from('tracks').upload(filePath, file)
        if (uploadError) throw uploadError

        let coverPath: string | null = null
        if (meta.coverBlob) {
          coverPath = `${crypto.randomUUID()}.jpg`
          await supabase.storage.from('covers').upload(coverPath, meta.coverBlob)
        }

        const { data: trackRow, error: insertError } = await supabase
          .from('tracks')
          .insert({
            title: meta.title,
            artist: meta.artist,
            file_path: filePath,
            cover_path: coverPath,
            duration_seconds: meta.durationSeconds,
            file_size_bytes: file.size,
          })
          .select('id')
          .single()
        if (insertError) throw insertError

        await supabase.from('playlist_items').insert({
          track_id: trackRow.id,
          position: nextPosition++,
        })

        log.push(`OK: ${meta.artist} — ${meta.title}`)
      } catch (err) {
        log.push(`FAILED: ${file.name} (${(err as Error).message})`)
      }
    }

    setResults(log)
    setUploading(false)
    reload()
  }

  async function handleDelete(trackId: string) {
    await supabase.from('tracks').delete().eq('id', trackId)
    reload()
  }

  async function handleToggle(trackId: string, isEnabled: boolean) {
    await supabase.from('tracks').update({ is_enabled: !isEnabled }).eq('id', trackId)
    reload()
  }

  async function handleReorder(fromPosition: number, toIndex: number) {
    const moved = entries.find((e) => e.position === fromPosition)
    if (!moved) return

    const reordered = entries.filter((e) => e.position !== fromPosition).sort((a, b) => a.position - b.position)
    reordered.splice(toIndex, 0, moved)

    const failures: string[] = []
    for (let i = 0; i < reordered.length; i++) {
      const { error } = await supabase
        .from('playlist_items')
        .update({ position: i + 1 })
        .eq('track_id', reordered[i].track.id)
      if (error) {
        failures.push(`REORDER FAILED: ${reordered[i].track.title} (${error.message})`)
      }
    }
    if (failures.length > 0) {
      setResults(failures)
    }
    reload()
  }

  return (
    <div className="admin-library">
      <h2>LIBRARY</h2>
      <input
        type="file"
        accept="audio/mpeg,audio/mp4,audio/wav"
        multiple
        disabled={uploading}
        onChange={(e) => handleFiles(e.target.files)}
      />
      {uploading && <p>Uploading…</p>}
      <ul className="admin-library__results">
        {results.map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ul>

      <ul className="admin-library__list">
        {entries.map((entry, index) => (
          <li
            key={entry.track.id}
            draggable
            onDragStart={(e) => e.dataTransfer.setData('text/plain', String(entry.position))}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => handleReorder(Number(e.dataTransfer.getData('text/plain')), index)}
          >
            <span>
              {entry.position}. {entry.track.artist} — {entry.track.title}
            </span>
            <button onClick={() => handleToggle(entry.track.id, entry.track.isEnabled)}>
              {entry.track.isEnabled ? 'Disable' : 'Enable'}
            </button>
            <button onClick={() => handleDelete(entry.track.id)}>Delete</button>
          </li>
        ))}
      </ul>
    </div>
  )
}
```

- [ ] **Step 2: Append admin styles to `src/styles/theme.css`**

```css
.admin-library,
.admin-radio-controls {
  padding: 16px;
  padding-bottom: 80px;
}

.admin-library h2,
.admin-radio-controls h2 {
  text-transform: uppercase;
  letter-spacing: 2px;
  color: var(--color-accent);
}

.admin-library__list,
.admin-radio-controls ul {
  list-style: none;
  padding: 0;
}

.admin-library__list li,
.admin-radio-controls li {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border-bottom: 1px solid var(--color-surface);
  cursor: grab;
}

.admin-library button,
.admin-radio-controls button {
  background: var(--color-surface);
  color: var(--color-text);
  border: 1px solid var(--color-muted);
  padding: 6px 10px;
  border-radius: 4px;
  cursor: pointer;
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: only the still-missing `src/App.tsx` error remains (fixed in Task 11).

- [ ] **Step 4: Commit**

```bash
git add src/screens/AdminLibrary.tsx src/styles/theme.css
git commit -m "feat: add admin library screen (upload, edit, delete, reorder)"
```

---

### Task 10: Admin radio controls screen

**Files:**
- Create: `src/screens/AdminRadioControls.tsx`

**Interfaces:**
- Consumes: `supabase`, `fetchPlaylist`, `fetchRadioState`, `PlaylistEntry` (Task 7).
- Produces (used by Task 11's `App.tsx`): `export function AdminRadioControls(): JSX.Element`.

- [ ] **Step 1: Write `src/screens/AdminRadioControls.tsx`**

```tsx
import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { fetchPlaylist, fetchRadioState, type PlaylistEntry } from '../lib/tracks'

export function AdminRadioControls() {
  const [entries, setEntries] = useState<PlaylistEntry[]>([])
  const [isPlaying, setIsPlaying] = useState(false)

  async function reload() {
    setEntries(await fetchPlaylist())
    const state = await fetchRadioState()
    setIsPlaying(state?.isPlaying ?? false)
  }

  useEffect(() => {
    reload()
  }, [])

  async function handlePause() {
    await supabase.rpc('radio_pause')
    reload()
  }

  async function handleResume() {
    await supabase.rpc('radio_resume')
    reload()
  }

  async function handleSkip(position: number) {
    await supabase.rpc('radio_skip_to', { target_position: position })
    reload()
  }

  return (
    <div className="admin-radio-controls">
      <h2>RADIO</h2>
      <p>Status: {isPlaying ? 'PLAYING' : 'PAUSED'}</p>
      <button onClick={isPlaying ? handlePause : handleResume}>{isPlaying ? 'PAUSE' : 'RESUME'}</button>
      <ul>
        {entries.map((entry) => (
          <li key={entry.track.id}>
            <span>
              {entry.position}. {entry.track.artist} — {entry.track.title}
            </span>
            <button onClick={() => handleSkip(entry.position)}>Skip here</button>
          </li>
        ))}
      </ul>
    </div>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: only the still-missing `src/App.tsx` error remains (fixed in Task 11).

- [ ] **Step 3: Commit**

```bash
git add src/screens/AdminRadioControls.tsx
git commit -m "feat: add admin radio controls screen (play/pause/skip)"
```

---

### Task 11: App integration

**Files:**
- Create: `src/App.tsx`
- Modify: `src/styles/theme.css` (append nav styles)

**Interfaces:**
- Consumes: `initTelegramApp` (Task 7), `authenticate` (Task 7), `RadioScreen` (Task 8), `AdminLibrary` (Task 9), `AdminRadioControls` (Task 10).
- Produces: `export default function App(): JSX.Element`, rendered by `src/main.tsx` (Task 1).

- [ ] **Step 1: Write `src/App.tsx`**

```tsx
import { useEffect, useState } from 'react'
import { initTelegramApp } from './lib/telegram'
import { authenticate } from './lib/auth'
import { RadioScreen } from './screens/RadioScreen'
import { AdminLibrary } from './screens/AdminLibrary'
import { AdminRadioControls } from './screens/AdminRadioControls'

type Tab = 'radio' | 'library' | 'controls'

export default function App() {
  const [isAdmin, setIsAdmin] = useState(false)
  const [tab, setTab] = useState<Tab>('radio')
  const [ready, setReady] = useState(false)

  useEffect(() => {
    initTelegramApp()
    authenticate().then((result) => {
      setIsAdmin(result.isAdmin)
      setReady(true)
    })
  }, [])

  if (!ready) {
    return <div className="app-loading">BIGUNDER FM</div>
  }

  return (
    <div className="app">
      {tab === 'radio' && <RadioScreen />}
      {tab === 'library' && isAdmin && <AdminLibrary />}
      {tab === 'controls' && isAdmin && <AdminRadioControls />}

      {isAdmin && (
        <nav className="app__admin-nav">
          <button onClick={() => setTab('radio')}>Radio</button>
          <button onClick={() => setTab('library')}>Library</button>
          <button onClick={() => setTab('controls')}>Controls</button>
        </nav>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Append nav styles to `src/styles/theme.css`**

```css
.app__admin-nav {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  display: flex;
  justify-content: space-around;
  background: var(--color-surface);
  border-top: 1px solid #262626;
  padding: 8px;
}
```

- [ ] **Step 3: Typecheck and build**

Run: `npm run typecheck`
Expected: PASS, no errors.

Run: `npm run build`
Expected: PASS, `dist/` produced. (Requires `.env.local` from Task 6 to exist locally for the build's `import.meta.env` substitution — if it doesn't exist yet, create it now from Task 6's captured values before building.)

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: PASS (all `radioClock` and `metadata` tests green).

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx src/styles/theme.css
git commit -m "feat: wire up App with radio/admin tabs and Telegram auth"
```

---

### Task 12: README and deployment instructions

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: nothing (documentation only).
- Produces: setup/deploy instructions for the project owner.

- [ ] **Step 1: Write `README.md`**

```markdown
# BIGUNDER FM

Underground internet radio as a Telegram Mini App. One shared, continuously
looping playlist; every listener hears (approximately) the same thing at the
same time via a synchronized virtual timeline — no streaming server involved.
See `docs/superpowers/specs/2026-09-05-bigunderfm-design.md` for the full
design.

## Stack

- Frontend: Vite + React + TypeScript, deployed on Cloudflare Pages.
- Backend: Supabase (Postgres, Storage, Realtime, one Edge Function). No
  custom server process.

## Local development

```bash
npm install
cp .env.example .env.local   # fill in VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
npm run dev
```

Outside Telegram, `getInitData()` returns an empty string, so the app loads
as a plain (non-admin) listener — the admin tabs only appear inside a real
Telegram session for an allowlisted user.

## One-time setup checklist

1. **Supabase project** — already provisioned; migrations in
   `supabase/migrations/` and the `telegram-auth` function in
   `supabase/functions/telegram-auth/` are applied/deployed.
2. **Create the Telegram bot** — via [@BotFather](https://t.me/BotFather):
   `/newbot`, follow the prompts, save the bot token.
3. **Set the bot token as a function secret** — in the Supabase dashboard,
   under Edge Functions → `telegram-auth` → secrets, set
   `TELEGRAM_BOT_TOKEN` to the token from step 2.
4. **Seed the admins table** — run this in the Supabase SQL editor, using
   your own Telegram numeric user id (get it from
   [@userinfobot](https://t.me/userinfobot)):
   ```sql
   insert into admins (telegram_user_id) values (123456789);
   ```
5. **Deploy the frontend to Cloudflare Pages** — in the Cloudflare
   dashboard: Workers & Pages → Create → Pages → connect the
   `staffvpn/bigunderfm` GitHub repo. Build command: `npm run build`.
   Build output directory: `dist`. Add environment variables
   `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (same values as
   `.env.local`).
6. **Point the bot at the app** — in BotFather: `/newapp` (or
   `/mybots` → your bot → Bot Settings → Menu Button / Mini App), set the
   Web App URL to the Cloudflare Pages domain from step 5.
7. **Upload tracks** — open the bot in Telegram as the admin account, use
   the hidden Library tab to upload tracks, then hit Resume in the Controls
   tab to start the radio.

## Known limitations (see spec §13)

- Supabase's free plan pauses a project after ~7 days with zero API
  activity — restore it from the Supabase dashboard if that happens.
- Track transitions have a small (sub-second) gap; this is not a
  sample-accurate crossfade.
- No external stream URL — playback only works inside this Mini App.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add README with setup and deployment checklist"
```

---

### Task 13: Final push

**Files:** none.

**Interfaces:**
- Consumes: all prior commits.
- Produces: everything pushed to `https://github.com/staffvpn/bigunderfm` on `main`.

- [ ] **Step 1: Push**

```bash
git push origin main
```

- [ ] **Step 2: Verify**

Confirm via the GitHub API (or `git ls-remote`) that `main` on the remote matches local `HEAD`.
