# BIGUNDER FM

Underground internet radio as a Telegram Mini App. One shared, continuously
looping playlist; every listener hears (approximately) the same thing at the
same time via a synchronized virtual timeline — no streaming server involved.
See `docs/superpowers/specs/2026-09-05-bigunderfm-design.md` for the full
design.

## Stack

- Frontend: Vite + React + TypeScript, deployed on Cloudflare Pages.
- Backend: Supabase (Postgres, Storage, Realtime, two Edge Functions). No
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
(`bigunderfm`, `eu-west-1`) exists with all 4 migrations applied,
`telegram-auth` and `telegram-bot-webhook` both deployed, and the bot's
webhook registered. The worktree's `.env.local` already has the real
`VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`. Steps 1, 3, 4, 6, 7, 9, 10, 11
below are done; **step 5 and step 8 remain** — both need Supabase dashboard
access no tool available to this assistant has.

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
   Project Settings → Edge Functions → Secrets:
   `TELEGRAM_BOT_TOKEN=<the token>`. **Not yet confirmed set — required
   before Telegram sign-in AND bot track uploads (see below) work at all.**
   Both `telegram-auth` and `telegram-bot-webhook` read the same secret.

9. ~~**Seed the admins table**~~ — done. `@wantedflesh` (`929887068`) and
   `@Tesoneer` (`432943377`) are both seeded in the live `admins` table.
   More admins can be added later the same way (numeric Telegram user id,
   looked up via [@userinfobot](https://t.me/userinfobot)), any time,
   without a redeploy:
   ```sql
   insert into admins (telegram_user_id) values (<numeric id>);
   ```
10. ~~**Deploy the frontend to Cloudflare Pages**~~ — done, live at
    `https://bigunderfm.pages.dev`.
11. ~~**Point the bot at the app**~~ — done.
12. **Upload tracks** — two ways, both land in the same library:
    - **In the app**: open the bot's Mini App as an admin, use the hidden
      Library tab.
    - **Straight in the chat** (`telegram-bot-webhook`): any of the
      allowlisted admins can send or forward an audio file directly to the
      bot in a private chat. The bot checks the sender's numeric Telegram
      id against the `admins` table (silently ignores anyone else),
      downloads the file, uploads it to Storage, inserts it into the
      library and playlist, replies "Готово: artist — title", then
      deletes both its own reply and the original message — nothing
      lingers in the chat. Title/artist/cover art still get edited inside
      the app afterwards, same as an app upload.

      Telegram itself decides per file whether to classify it as a
      playable "audio" message (with a duration) or a generic document
      (without one) — there's no menu choice for this. mp3/m4a normally
      come through as audio automatically; **.wav often doesn't**, and
      duration is load-bearing for the shared playback timeline (same
      reasoning as `src/lib/audioDuration.ts` on the client side), so a
      file that arrives without one gets a reply asking to recode it to
      mp3 or upload it via the app's Library tab instead, rather than the
      bot silently guessing a duration.

      The webhook is already registered
      (`https://dxkotfirmgxxhhunuvgf.supabase.co/functions/v1/telegram-bot-webhook`,
      confirmed via `getWebhookInfo`) — nothing further to set up here
      once step 8's secret is in place.
    Then hit Resume in the Controls tab to start the radio.

## Known limitations (see spec §13)

- Supabase's free plan pauses a project after ~7 days with zero API
  activity — restore it from the Supabase dashboard if that happens.
- Track transitions have a small (sub-second) gap; this is not a
  sample-accurate crossfade.
- No external stream URL — playback only works inside this Mini App.
