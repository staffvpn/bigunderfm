import { createClient } from 'jsr:@supabase/supabase-js@2'

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

async function isAdmin(telegramUserId: number): Promise<boolean> {
  const { data } = await adminClient
    .from('admins')
    .select('telegram_user_id')
    .eq('telegram_user_id', telegramUserId)
    .maybeSingle()
  return Boolean(data)
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

  const fileInfo = await callTelegram('getFile', { file_id: audio.file_id })
  const telegramFilePath = fileInfo?.result?.file_path
  if (!telegramFilePath) {
    await sendMessage(chatId, 'Не получилось скачать файл из Telegram.')
    return
  }

  const fileRes = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${telegramFilePath}`)
  if (!fileRes.ok) {
    await sendMessage(chatId, 'Не получилось скачать файл из Telegram.')
    return
  }
  const bytes = new Uint8Array(await fileRes.arrayBuffer())

  const storagePath = buildTrackFilePath(audio.file_name)
  const { error: uploadError } = await adminClient.storage
    .from('tracks')
    .upload(storagePath, bytes, { contentType })
  if (uploadError) {
    await sendMessage(chatId, `Ошибка загрузки: ${uploadError.message}`)
    return
  }

  const title = audio.title?.trim() || (audio.file_name ? stripExtension(audio.file_name) : 'Untitled')
  const artist = audio.performer?.trim() || 'Unknown Artist'

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
    await sendMessage(chatId, `Ошибка сохранения: ${insertError?.message ?? 'unknown'}`)
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

    if (!(await isAdmin(message.from.id))) {
      // Silently ignore non-admins: no reply, no trace this bot does
      // anything beyond whatever else it's used for.
      return new Response('ok', { status: 200 })
    }

    if (message.audio) {
      await processAudioMessage(message, message.audio)
    } else if (message.document?.mime_type?.startsWith('audio/')) {
      // Telegram itself decides audio vs. generic document per file —
      // there's no menu choice for this. mp3/m4a normally come through
      // as audio automatically; .wav in particular often doesn't, and
      // Telegram never attaches a duration to a document either way.
      await sendMessage(
        message.chat.id,
        '🚨 wav-подобное: Telegram прислал этот файл без длительности — бот не может его принять. ' +
          'Перекодируй в mp3 и перешли ещё раз, либо загрузи через вкладку "Библиотека" в самом приложении.',
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
