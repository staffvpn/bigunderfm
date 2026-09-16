import { createClient } from 'jsr:@supabase/supabase-js@2'
import { S3Client, PutObjectCommand } from 'npm:@aws-sdk/client-s3@3.658.1'

// Tracks moved off Supabase Storage to Cloudflare R2 (2026-09-16) —
// Supabase's free-tier egress quota got exhausted by the live stream
// re-fetching the same rotation on repeat, which silently 402'd the
// entire project (Storage AND the database REST API) until upgraded or
// reset. R2 has zero egress fees, so the exact same usage pattern can
// never trigger this again. Credentials are inlined (not env secrets)
// because this environment has no way to set Edge Function secrets
// remotely — same reasoning as CRON_SECRET in quota-check/index.ts.
const R2_ACCOUNT_ID = 'df8e0891ca07f7c0a3b4406039787801'
const R2_ACCESS_KEY_ID = '166fc1d1799c8328174359708f875c5a'
const R2_SECRET_ACCESS_KEY = '5413590eda6670c3e150ab9b5f7c0e4ecd0d46c19ae6c574176d3c935f27c180'
const R2_BUCKET = 'bigunderfm-media'

const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
})

async function uploadToR2(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
  await r2.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: bytes, ContentType: contentType }))
}

// Storage path/content-type helpers — same rules as
// src/lib/storagePath.ts (Storage rejects keys with spaces or
// non-ASCII, and only accepts an exact Content-Type per bucket). Kept
// inline rather than in a shared module: this Edge Function's deploy
// tool bundles a single file and doesn't resolve a separate relative
// import, and it's little enough code that duplicating beats fighting
// cross-runtime (Deno vs. Vite/browser) module sharing for one function.
function safeExtensionFromName(filename: string | undefined): string {
  if (!filename) return ''
  const match = filename.match(/\.([a-zA-Z0-9]+)$/)
  return match ? `.${match[1].toLowerCase()}` : ''
}

function buildTrackFilePath(filename: string | undefined, id: string = crypto.randomUUID()): string {
  return `${id}${safeExtensionFromName(filename)}`
}

/**
 * Resolves the exact Content-Type the `tracks` Storage bucket's
 * allowed_mime_types accepts (0003_storage.sql), or null if the file's
 * format isn't one of the three the bucket allows at all.
 */
function resolveAudioContentType(filename: string | undefined, telegramMimeType: string | undefined): string | null {
  switch (safeExtensionFromName(filename)) {
    case '.mp3':
      return 'audio/mpeg'
    case '.wav':
      return 'audio/wav'
    case '.m4a':
    case '.mp4':
      return 'audio/mp4'
  }
  if (telegramMimeType === 'audio/mpeg' || telegramMimeType === 'audio/mp4' || telegramMimeType === 'audio/wav') {
    return telegramMimeType
  }
  return null
}

function stripExtension(filename: string): string {
  const lastDot = filename.lastIndexOf('.')
  return lastDot > 0 ? filename.slice(0, lastDot) : filename
}

const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`

const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

interface TelegramAudio {
  file_id: string
  duration: number
  performer?: string
  title?: string
  file_name?: string
  mime_type?: string
  file_size?: number
}

interface TelegramMessage {
  message_id: number
  chat: { id: number }
  from?: { id: number }
  text?: string
  audio?: TelegramAudio
  document?: { file_name?: string; mime_type?: string }
}

async function callTelegram(method: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${TELEGRAM_API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json().catch(() => null)
}

async function sendMessage(chatId: number, text: string): Promise<number | null> {
  const result = await callTelegram('sendMessage', { chat_id: chatId, text })
  return result?.result?.message_id ?? null
}

async function deleteMessage(chatId: number, messageId: number): Promise<void> {
  await callTelegram('deleteMessage', { chat_id: chatId, message_id: messageId })
}

// Hardcoded rather than a DB lookup against the `admins` table — this
// check needs to keep working even when Supabase's own REST API is down
// or egress-restricted (exactly the failure mode this whole migration is
// about), so it can't depend on Supabase being reachable at all. Low risk
// either way: this only gates who can upload tracks via the bot, not any
// real security boundary — RLS still protects the database itself.
const ADMIN_TELEGRAM_IDS = new Set([929887068, 432943377])

function isAdmin(telegramUserId: number): boolean {
  return ADMIN_TELEGRAM_IDS.has(telegramUserId)
}

const ICECAST_STATUS_URL = 'https://159-194-234-135.sslip.io/status-json.xsl'
const SUPABASE_STORAGE_LIMIT_BYTES = 1024 * 1024 * 1024
const SUPABASE_DB_LIMIT_BYTES = 500 * 1024 * 1024
const SUPABASE_BILLING_URL = `https://supabase.com/dashboard/project/${SUPABASE_URL.match(/https:\/\/(.+)\.supabase\.co/)?.[1] ?? ''}/settings/billing/usage`

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} ГБ`
  return `${mb.toFixed(0)} МБ`
}

async function supabaseStorageBytes(): Promise<number> {
  let total = 0
  for (const bucket of ['tracks', 'covers']) {
    let offset = 0
    for (;;) {
      const { data, error } = await adminClient.storage.from(bucket).list('', { limit: 1000, offset })
      if (error || !data) break
      for (const obj of data) total += obj.metadata?.size ?? 0
      if (data.length < 1000) break
      offset += 1000
    }
  }
  return total
}

/**
 * On-demand /status snapshot — everything a "screenshot of Управление"
 * would show, as text instead (no headless-browser rendering available
 * here). Checks Icecast directly (works regardless of Supabase's own
 * health) and Supabase separately, so a Supabase outage shows up as its
 * own clearly-labeled line rather than silently breaking the whole reply.
 */
async function handleStatusCommand(chatId: number): Promise<void> {
  const lines: string[] = ['📊 СТАТУС BIGUNDER FM']

  try {
    const res = await fetch(ICECAST_STATUS_URL, { signal: AbortSignal.timeout(8000) })
    const data = await res.json()
    const source = data?.icestats?.source
    if (source) {
      lines.push('', '📻 Эфир: ✅ играет', `Сейчас: ${source.title ?? '—'}`, `Слушают: ${source.listeners ?? '—'}`)
    } else {
      lines.push('', '📻 Эфир: 🚨 источник не подключён')
    }
  } catch {
    lines.push('', '📻 Эфир: 🚨 сервер не отвечает')
  }

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/tracks?select=id&limit=1`, {
      headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    const [storageBytes, dbResult] = await Promise.all([supabaseStorageBytes(), adminClient.rpc('get_db_size_bytes')])
    const dbBytes = typeof dbResult.data === 'number' ? dbResult.data : null

    lines.push(
      '',
      '🗄️ Supabase: ✅ доступна',
      `Хранилище: ${formatBytes(storageBytes)} / ${formatBytes(SUPABASE_STORAGE_LIMIT_BYTES)} (${Math.round((storageBytes / SUPABASE_STORAGE_LIMIT_BYTES) * 100)}%)`,
    )
    if (dbBytes !== null) {
      lines.push(
        `База данных: ${formatBytes(dbBytes)} / ${formatBytes(SUPABASE_DB_LIMIT_BYTES)} (${Math.round((dbBytes / SUPABASE_DB_LIMIT_BYTES) * 100)}%)`,
      )
    }
    lines.push('', `Точный трафик (не показываю здесь): ${SUPABASE_BILLING_URL}`)
  } catch {
    lines.push('', '🗄️ Supabase: 🚨 недоступна (лимит трафика или другая ошибка)')
  }

  await sendMessage(chatId, lines.join('\n'))
}

async function nextPlaylistPosition(): Promise<number> {
  const { data } = await adminClient
    .from('playlist_items')
    .select('position')
    .order('position', { ascending: false })
    .limit(1)
  return (data?.[0]?.position ?? 0) + 1
}

/**
 * Handles one forwarded/uploaded audio message end to end: download from
 * Telegram, upload to Storage, insert tracks + playlist_items, confirm,
 * then delete both the confirmation and the original message — the file
 * now lives in the app's library; nothing needs to linger in the chat.
 * Metadata (title/artist/cover) is edited inside the app afterwards, not
 * here — this path only needs to get the file in reliably.
 */
async function processAudioMessage(message: TelegramMessage, audio: TelegramAudio): Promise<void> {
  const chatId = message.chat.id

  // Telegram populates `duration` itself from the file's own audio
  // stream whenever a message is sent/forwarded as an actual Audio
  // attachment — this is why message.document (generic "File" uploads)
  // is rejected below instead of guessed at: unlike this webhook, nothing
  // server-side here can reliably parse container headers by hand (see
  // src/lib/audioDuration.ts's client-side equivalent problem).
  if (!audio.duration || audio.duration <= 0) {
    await sendMessage(chatId, 'Не удалось определить длительность трека — попробуй переслать ещё раз.')
    return
  }

  const contentType = resolveAudioContentType(audio.file_name, audio.mime_type)
  if (!contentType) {
    await sendMessage(chatId, 'Формат не поддерживается — нужен mp3, wav или m4a.')
    return
  }

  // Telegram's own Bot API (api.telegram.org) hard-caps file *downloads*
  // at 20MB for every bot, regardless of what the bot account or Storage
  // bucket allows — this isn't a limit of ours and isn't tunable from
  // here. Checked against the size Telegram already sent in the message
  // itself (more reliable than waiting for getFile to fail and pattern-
  // matching its error text, which could change wording) — surfaced
  // precisely so this doesn't look identical to an actual outage and send
  // someone chasing the wrong problem.
  const TELEGRAM_BOT_API_DOWNLOAD_LIMIT = 20 * 1024 * 1024
  if (audio.file_size && audio.file_size > TELEGRAM_BOT_API_DOWNLOAD_LIMIT) {
    await sendMessage(chatId, '🚨 Файл больше 20 МБ — это лимит самого Telegram на скачивание файлов ботом, в коде это не обойти.')
    return
  }

  const fileInfo = await callTelegram('getFile', { file_id: audio.file_id })
  const telegramFilePath = fileInfo?.result?.file_path
  if (!telegramFilePath) {
    // Same 20MB cap can still bite even when Telegram didn't report
    // file_size up front — fall back to matching getFile's own error text.
    const tooBig = typeof fileInfo?.description === 'string' && /too big/i.test(fileInfo.description)
    await sendMessage(
      chatId,
      tooBig
        ? '🚨 Файл больше 20 МБ — это лимит самого Telegram на скачивание ботом, обойти нельзя.'
        : 'Не получилось скачать файл из Telegram.',
    )
    return
  }

  const fileRes = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${telegramFilePath}`)
  if (!fileRes.ok) {
    await sendMessage(chatId, 'Не получилось скачать файл из Telegram.')
    return
  }
  const bytes = new Uint8Array(await fileRes.arrayBuffer())

  const storagePath = buildTrackFilePath(audio.file_name)
  try {
    await uploadToR2(storagePath, bytes, contentType)
  } catch (err) {
    await sendMessage(chatId, `Ошибка загрузки в R2: ${(err as Error).message}`)
    return
  }

  const title = audio.title?.trim() || (audio.file_name ? stripExtension(audio.file_name) : 'Untitled')
  const artist = audio.performer?.trim() || 'Unknown Artist'

  // The file is safely in R2 at this point regardless of what happens
  // next — R2 is a separate service from Supabase, unaffected by
  // Supabase's own outages. The catalog entry below still goes through
  // Supabase's database, though, which — while it's in its current
  // egress-restricted state — may fail here even though the upload
  // itself succeeded. Told apart explicitly so a failure here doesn't
  // read as "lost the file", which it isn't.
  const { data: trackRow, error: insertError } = await adminClient
    .from('tracks')
    .insert({
      title,
      artist,
      file_path: storagePath,
      duration_seconds: audio.duration,
      file_size_bytes: audio.file_size ?? bytes.byteLength,
    })
    .select('id')
    .single()
  if (insertError || !trackRow) {
    await sendMessage(
      chatId,
      `Файл загружен (${artist} — ${title}), но сейчас не получилось добавить его в каталог ` +
        `(${insertError?.message ?? 'unknown'}) — скорее всего, Supabase всё ещё восстанавливается. ` +
        'Файл никуда не денется, его добавят в плейлист отдельно.',
    )
    return
  }

  await adminClient.from('playlist_items').insert({
    track_id: trackRow.id,
    position: await nextPlaylistPosition(),
  })

  const confirmId = await sendMessage(chatId, `✅ Готово: ${artist} — ${title}`)

  // Leave the confirmation on screen long enough to actually read it
  // before cleaning up — deleting it in the same instant it's sent means
  // it never visibly appears at all in a real Telegram client.
  await new Promise((resolve) => setTimeout(resolve, 4000))

  // Clean up after ourselves — the app's Library tab is the real place
  // to review/edit tracks from now on, not the chat.
  if (confirmId) await deleteMessage(chatId, confirmId)
  await deleteMessage(chatId, message.message_id)
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('ok', { status: 200 })
  }

  try {
    const update = await req.json()
    const message: TelegramMessage | undefined = update.message
    if (!message?.from) {
      return new Response('ok', { status: 200 })
    }

    if (!isAdmin(message.from.id)) {
      // Silently ignore non-admins: no reply, no trace this bot does
      // anything beyond whatever else it's used for.
      return new Response('ok', { status: 200 })
    }

    if (message.text?.trim().toLowerCase() === '/status') {
      await handleStatusCommand(message.chat.id)
    } else if (message.audio) {
      await processAudioMessage(message, message.audio)
    } else if (message.document?.mime_type?.startsWith('audio/')) {
      // Telegram itself decides audio vs. generic document per file —
      // there's no menu choice for this. mp3/m4a normally come through
      // as audio automatically; .wav in particular often doesn't, and
      // Telegram never attaches a duration to a document either way.
      await sendMessage(
        message.chat.id,
        '🚨 wav-подобное: Telegram прислал этот файл без длительности — бот не может его принять. ' +
          'Перекодируй в mp3 и перешли ещё раз.',
      )
    }

    return new Response('ok', { status: 200 })
  } catch (err) {
    console.error(err)
    // Always 200: Telegram retries non-2xx responses, which would replay
    // an upload that may have already partially succeeded.
    return new Response('ok', { status: 200 })
  }
})
