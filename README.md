# BIGUNDER FM

Underground internet radio as a Telegram Mini App. One shared, always-on
broadcast: Liquidsoap plays the library in a loop, Icecast streams it, and every
listener just connects to the same stream.

## Architecture

```
Telegram Mini App (Cloudflare Pages, src/)
        |
        +--> API: Cloudflare Worker "bigunderfm-api" (worker/)
        |      - D1 database   tracks, playlist, admins, logins, listener samples
        |      - R2 bucket     bigunderfm-media (audio files, covers)
        |      - Durable Object "Presence" (how many people have the app open)
        |      - cron, every minute: samples the Icecast listener count
        |      - Telegram bot webhook (/bot/webhook), /status, notifications
        |
        +--> audio: VPS (Icecast + Liquidsoap), /radio

VPS: sync-playlist.sh (cron, every minute) reads the library from the Worker
(/internal/playlist.tsv), writes /var/radio/playlist.m3u and reloads
Liquidsoap only when the library changed. See the comment at the top of the
script for how it keeps a reload from restarting the broadcast.
```

The previous Supabase backend was retired on 2026-09-20. `supabase/` is kept
only as history.

## Frontend

```bash
npm install
npm run dev          # VITE_API_URL optional, defaults to the production Worker
npm run build
npm test
```

Outside Telegram there is no signed `initData`, so the app runs as a plain
listener; the admin tabs only appear inside a real Telegram session for an
allowlisted user.

## Worker

```bash
cd worker
npm install --legacy-peer-deps
npm test                         # login / session token tests
npx wrangler deploy              # needs CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID
npx wrangler d1 execute bigunderfm --remote --command "select count(*) from tracks"
```

Schema: `worker/migrations/0001_init.sql`. Secrets (set with
`wrangler secret put`): `TELEGRAM_BOT_TOKEN`, `JWT_SECRET`, `INTERNAL_SECRET`,
`WEBHOOK_SECRET`, `SKIP_BRIDGE_SECRET`; optional `CF_ANALYTICS_TOKEN` +
`CF_ACCOUNT_ID` for real usage numbers in the bot's `/status`.

Add an admin (numeric Telegram id, e.g. from @userinfobot):

```sql
insert into admins (telegram_user_id) values (<id>);
```

## Uploading tracks

- In the app: open the Mini App as an admin, Library tab (up to 50 MB).
- In the bot: send or forward an audio file to the bot in a private chat
  (Telegram limits bot downloads to 20 MB; files without a duration, often
  .wav, are refused - recode to mp3).

Both paths store the file in R2 and append the track to the playlist.

## Known limitations

- Track transitions have a small (sub-second) gap; no crossfade.
- The stream only plays inside this Mini App.
- Free-plan limits (Cloudflare): 100k Worker requests/day, D1 5 GB and
  100k row writes/day, R2 10 GB. The bot's `/status` shows current usage.
