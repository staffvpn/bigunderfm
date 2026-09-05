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
