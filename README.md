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

Nothing below is provisioned yet — the backend must be created from scratch
by following these steps in order.

1. **Create the Supabase project** — at
   [supabase.com/dashboard](https://supabase.com/dashboard): New project,
   free plan, pick a low-latency region. Note the **project ref** (the
   `xxxxxxxxxxxx` in the project URL) and the **anon key** from
   Project Settings → API.

   ⚠️ The free plan allows only 2 active projects per organization, and this
   project's org is currently **at that limit**. Before creating a new one
   you must pause or delete an existing free project, upgrade the org to Pro,
   or create the project in a different organization.

2. **Install the Supabase CLI** — see
   [supabase.com/docs/guides/cli](https://supabase.com/docs/guides/cli),
   e.g. `npm install -g supabase` or `scoop install supabase`. Then log in:
   ```bash
   supabase login
   ```

3. **Link this repo to the project** — from the repo root:
   ```bash
   supabase link --project-ref <your-project-ref>
   ```

4. **Apply the database migrations**:
   ```bash
   supabase db push
   ```
   This applies all four files in `supabase/migrations/` in order:
   `0001_init.sql` (tables + RLS), `0002_radio_rpc.sql` (radio timeline
   RPCs), `0003_storage.sql` (buckets + storage policies), and
   `0004_realtime.sql` (adds `radio_state` and `playlist_items` to the
   `supabase_realtime` publication — without it the app receives no
   realtime updates at all).

5. **Enable anonymous sign-ins** — in the Supabase dashboard:
   Authentication → Sign In / Providers → enable **"Allow anonymous
   sign-ins."** This is **off by default** and the entire auth flow
   (`src/lib/auth.ts`) depends on it: every visitor, admin or listener,
   first signs in anonymously before `telegram-auth` runs. Nothing in the
   app works until this is on.

6. **Deploy the edge function**:
   ```bash
   supabase functions deploy telegram-auth
   ```

7. **Create the Telegram bot** — via [@BotFather](https://t.me/BotFather):
   `/newbot`, follow the prompts, save the bot token.

8. **Set the bot token as a function secret**:
   ```bash
   supabase secrets set TELEGRAM_BOT_TOKEN=<token-from-step-7>
   ```
   (or in the dashboard under Edge Functions → Secrets).

9. **Seed the admins table** — the project's designated admins are
   **@wantedflesh** and **@Tesoneer**. The `admins` table is keyed by
   Telegram's numeric user id, not by @username (initData is validated
   against the numeric id), so look up each account's numeric id first —
   easiest way is to have each person message
   [@userinfobot](https://t.me/userinfobot) and share back the number it
   replies with — then run this in the Supabase SQL editor:
   ```sql
   insert into admins (telegram_user_id) values
     (111111111), -- @wantedflesh
     (222222222); -- @Tesoneer
   ```
   Replace both placeholder numbers with the real ids. More admins can be
   added later the same way, any time, without a redeploy.
10. **Deploy the frontend to Cloudflare Pages** — in the Cloudflare
    dashboard: Workers & Pages → Create → Pages → connect the
    `staffvpn/bigunderfm` GitHub repo. Build command: `npm run build`.
    Build output directory: `dist`. Add environment variables
    `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (the project URL and
    anon key from step 1).
11. **Point the bot at the app** — in BotFather: `/newapp` (or
    `/mybots` → your bot → Bot Settings → Menu Button / Mini App), set the
    Web App URL to the Cloudflare Pages domain from step 10.
12. **Upload tracks** — open the bot in Telegram as the admin account, use
    the hidden Library tab to upload tracks, then hit Resume in the Controls
    tab to start the radio.

## Known limitations (see spec §13)

- Supabase's free plan pauses a project after ~7 days with zero API
  activity — restore it from the Supabase dashboard if that happens.
- Track transitions have a small (sub-second) gap; this is not a
  sample-accurate crossfade.
- No external stream URL — playback only works inside this Mini App.
