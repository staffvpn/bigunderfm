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

The backend is provisioned: Supabase project `dxkotfirmgxxhhunuvgf`
(`bigunderfm`, `eu-west-1`) exists with all 4 migrations applied and
`telegram-auth` deployed. The worktree's `.env.local` already has the real
`VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`. Steps 1, 3, 4, 6, 7 below are
done; **steps 5, 8, 9, 10, 11 remain** — each needs either dashboard access
or information only the project's admins have, so no tool available to this
assistant could complete them.

1. ~~**Create the Supabase project**~~ — done (`dxkotfirmgxxhhunuvgf`).

2. **Install the Supabase CLI** — see
   [supabase.com/docs/guides/cli](https://supabase.com/docs/guides/cli),
   e.g. `npm install -g supabase` or `scoop install supabase`. Then log in:
   ```bash
   supabase login
   ```
   (Optional — only needed if you want to manage this project from your own
   machine going forward. Everything through step 7 was done without it via
   direct Supabase tooling.)

3. ~~**Link this repo to the project**~~ — not needed unless you install the
   CLI per step 2; project ref is `dxkotfirmgxxhhunuvgf`.

4. ~~**Apply the database migrations**~~ — done; all four files in
   `supabase/migrations/` (`0001_init.sql`, `0002_radio_rpc.sql`,
   `0003_storage.sql`, `0004_realtime.sql`) are applied and verified live.

5. **Enable anonymous sign-ins** — in the Supabase dashboard:
   Authentication → Sign In / Providers → enable **"Allow anonymous
   sign-ins."** This is **off by default**, has no API/MCP toggle, and the
   entire auth flow (`src/lib/auth.ts`) depends on it: every visitor, admin
   or listener, first signs in anonymously before `telegram-auth` runs.
   Nothing in the app works until this is on. **Not yet confirmed enabled —
   check this before testing.**

6. ~~**Deploy the edge function**~~ — done; `telegram-auth` is live
   (version 1, ACTIVE) with no changes from the reviewed code.

7. ~~**Create the Telegram bot**~~ — done; bot token has been supplied.

8. **Set the bot token as a function secret** — no MCP tool and no local
   Supabase CLI can do this; set it manually in the dashboard under
   Project Settings → Edge Functions → `telegram-auth` → Secrets:
   `TELEGRAM_BOT_TOKEN=<the token>`. **Not yet set — required before Telegram
   sign-in will work at all.**

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
