import type { Env } from './env'
import { audioContentType, buildTrackKey, formatBytes, nowIso, sleep, stripExtension } from './util'

// Telegram bot webhook: /status for admins, and audio upload straight into the library.

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

// Limits of the Cloudflare Free plan (what this project runs on). Shown in /status.
// Source: developers.cloudflare.com (Workers / D1 / R2 pricing pages).
export const CF_LIMITS = {
  r2StorageBytes: 10 * 1024 ** 3,
  d1StorageBytes: 5 * 1024 ** 3,
  workersRequestsPerDay: 100_000,
  d1RowsReadPerDay: 5_000_000,
  d1RowsWrittenPerDay: 100_000,
}

export async function callTelegram(env: Env, method: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json().catch(() => null)
}

async function sendMessage(env: Env, chatId: number, text: string): Promise<number | null> {
  const result = await callTelegram(env, 'sendMessage', { chat_id: chatId, text })
  return result?.result?.message_id ?? null
}

async function deleteMessage(env: Env, chatId: number, messageId: number): Promise<void> {
  await callTelegram(env, 'deleteMessage', { chat_id: chatId, message_id: messageId })
}

async function isAdmin(env: Env, telegramUserId: number): Promise<boolean> {
  const row = await env.DB.prepare('select telegram_user_id from admins where telegram_user_id = ?')
    .bind(telegramUserId)
    .first()
  return Boolean(row)
}

function pct(used: number, limit: number): string {
  return `${Math.round((used / limit) * 100)}%`
}

async function r2UsedBytes(env: Env): Promise<{ bytes: number; objects: number }> {
  let bytes = 0
  let objects = 0
  let cursor: string | undefined
  do {
    const page = await env.MEDIA.list({ cursor, limit: 1000 })
    for (const o of page.objects) {
      bytes += o.size
      objects++
    }
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  return { bytes, objects }
}

/** Real request usage today, only if a read-only Analytics token was configured. */
async function todayUsage(env: Env): Promise<{ requests: number; rowsRead: number; rowsWritten: number } | null> {
  if (!env.CF_ANALYTICS_TOKEN || !env.CF_ACCOUNT_ID) return null
  const day = new Date().toISOString().slice(0, 10)
  const query = `query($acc: String!, $since: Time!, $day: Date!) {
    viewer { accounts(filter: { accountTag: $acc }) {
      workers: workersInvocationsAdaptive(limit: 100, filter: { datetime_geq: $since }) { sum { requests } }
      d1: d1AnalyticsAdaptiveGroups(limit: 100, filter: { date_geq: $day }) { sum { rowsRead rowsWritten } }
    } } }`
  try {
    const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { acc: env.CF_ACCOUNT_ID, since: `${day}T00:00:00Z`, day } }),
    })
    const data: any = await res.json()
    const acc = data?.data?.viewer?.accounts?.[0]
    if (!acc) return null
    const sum = (rows: any[] | undefined, key: string) => (rows ?? []).reduce((s, r) => s + (r?.sum?.[key] ?? 0), 0)
    return { requests: sum(acc.workers, 'requests'), rowsRead: sum(acc.d1, 'rowsRead'), rowsWritten: sum(acc.d1, 'rowsWritten') }
  } catch {
    return null
  }
}

/** On-demand /status: stream health plus Cloudflare usage against the Free-plan limits. */
export async function buildStatusText(env: Env): Promise<string> {
  const lines: string[] = ['📊 СТАТУС BIGUNDER FM']

  try {
    const res = await fetch(env.ICECAST_STATUS_URL, { signal: AbortSignal.timeout(8000) })
    const source = ((await res.json()) as any)?.icestats?.source
    if (source) {
      lines.push('', '📻 Эфир: ✅ играет', `Сейчас: ${source.title ?? '—'}`, `Слушают: ${source.listeners ?? '—'}`)
    } else {
      lines.push('', '📻 Эфир: 🚨 источник не подключён')
    }
  } catch {
    lines.push('', '📻 Эфир: 🚨 сервер не отвечает')
  }

  try {
    const [r2, tracks, dbMeta] = await Promise.all([
      r2UsedBytes(env),
      env.DB.prepare('select count(*) as n, coalesce(sum(is_enabled), 0) as on_air from tracks').first<{ n: number; on_air: number }>(),
      env.DB.prepare('select 1').run(),
    ])
    const dbBytes = (dbMeta.meta as { size_after?: number }).size_after ?? 0
    lines.push(
      '',
      '☁️ Cloudflare (тариф Free): ✅ работает',
      `Файлы R2: ${formatBytes(r2.bytes)} / ${formatBytes(CF_LIMITS.r2StorageBytes)} (${pct(r2.bytes, CF_LIMITS.r2StorageBytes)}), объектов: ${r2.objects}`,
      `База D1: ${formatBytes(dbBytes)} / ${formatBytes(CF_LIMITS.d1StorageBytes)} (${pct(dbBytes, CF_LIMITS.d1StorageBytes)})`,
      `Треков: ${tracks?.n ?? 0}, в эфире: ${tracks?.on_air ?? 0}`,
    )
    const usage = await todayUsage(env)
    if (usage) {
      lines.push(
        `Запросы сегодня: ${usage.requests} / ${CF_LIMITS.workersRequestsPerDay} (${pct(usage.requests, CF_LIMITS.workersRequestsPerDay)})`,
        `D1 чтение сегодня: ${usage.rowsRead} / ${CF_LIMITS.d1RowsReadPerDay} (${pct(usage.rowsRead, CF_LIMITS.d1RowsReadPerDay)})`,
        `D1 запись сегодня: ${usage.rowsWritten} / ${CF_LIMITS.d1RowsWrittenPerDay} (${pct(usage.rowsWritten, CF_LIMITS.d1RowsWrittenPerDay)})`,
      )
    } else {
      lines.push(
        `Дневные лимиты Free: ${CF_LIMITS.workersRequestsPerDay} запросов, D1 ${CF_LIMITS.d1RowsReadPerDay} чтений / ${CF_LIMITS.d1RowsWrittenPerDay} записей (счётчик использования не подключён)`,
      )
    }
    lines.push('', 'Точный тариф и трафик: https://dash.cloudflare.com/?to=/:account/billing')
  } catch (err) {
    lines.push('', `☁️ Cloudflare: 🚨 ошибка (${(err as Error).message})`)
  }

  return lines.join('\n')
}

async function nextPlaylistPosition(env: Env): Promise<number> {
  const row = await env.DB.prepare('select coalesce(max(position), 0) as m from playlist_items').first<{ m: number }>()
  return (row?.m ?? 0) + 1
}

// Telegram's Bot API caps file downloads at 20MB for every bot.
const TELEGRAM_DOWNLOAD_LIMIT = 20 * 1024 * 1024

async function processAudioMessage(env: Env, message: TelegramMessage, audio: TelegramAudio): Promise<void> {
  const chatId = message.chat.id

  if (!audio.duration || audio.duration <= 0) {
    await sendMessage(env, chatId, 'Не удалось определить длительность трека — попробуй переслать ещё раз.')
    return
  }
  const contentType = audioContentType(audio.file_name, audio.mime_type)
  if (!contentType) {
    await sendMessage(env, chatId, 'Формат не поддерживается — нужен mp3, wav или m4a.')
    return
  }
  if (audio.file_size && audio.file_size > TELEGRAM_DOWNLOAD_LIMIT) {
    await sendMessage(env, chatId, '🚨 Файл больше 20 МБ — это лимит самого Telegram на скачивание файлов ботом, в коде это не обойти.')
    return
  }

  const fileInfo = await callTelegram(env, 'getFile', { file_id: audio.file_id })
  const telegramFilePath = fileInfo?.result?.file_path
  if (!telegramFilePath) {
    const tooBig = typeof fileInfo?.description === 'string' && /too big/i.test(fileInfo.description)
    await sendMessage(
      env,
      chatId,
      tooBig ? '🚨 Файл больше 20 МБ — это лимит самого Telegram на скачивание ботом, обойти нельзя.' : 'Не получилось скачать файл из Telegram.',
    )
    return
  }

  const fileRes = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${telegramFilePath}`)
  if (!fileRes.ok) {
    await sendMessage(env, chatId, 'Не получилось скачать файл из Telegram.')
    return
  }
  const bytes = await fileRes.arrayBuffer()

  const key = buildTrackKey(audio.file_name)
  try {
    await env.MEDIA.put(key, bytes, { httpMetadata: { contentType } })
  } catch (err) {
    await sendMessage(env, chatId, `Ошибка загрузки в R2: ${(err as Error).message}`)
    return
  }

  const title = audio.title?.trim() || (audio.file_name ? stripExtension(audio.file_name) : 'Untitled')
  const artist = audio.performer?.trim() || 'Unknown Artist'
  const trackId = crypto.randomUUID()
  try {
    const position = await nextPlaylistPosition(env)
    await env.DB.batch([
      env.DB.prepare(
        'insert into tracks (id, title, artist, file_path, duration_seconds, file_size_bytes, created_at) values (?, ?, ?, ?, ?, ?, ?)',
      ).bind(trackId, title, artist, key, audio.duration, audio.file_size ?? bytes.byteLength, nowIso()),
      env.DB.prepare('insert into playlist_items (id, track_id, position) values (?, ?, ?)').bind(
        crypto.randomUUID(),
        trackId,
        position,
      ),
    ])
  } catch (err) {
    await env.MEDIA.delete(key)
    await sendMessage(env, chatId, `Не получилось добавить трек в каталог: ${(err as Error).message}. Попробуй ещё раз.`)
    return
  }

  const confirmId = await sendMessage(env, chatId, `✅ Готово: ${artist} — ${title}`)
  // Leave the confirmation readable for a moment, then clean the chat up.
  await sleep(4000)
  if (confirmId) await deleteMessage(env, chatId, confirmId)
  await deleteMessage(env, chatId, message.message_id)
}

export async function handleBotUpdate(update: any, env: Env): Promise<void> {
  const message: TelegramMessage | undefined = update?.message
  if (!message?.from) return
  // Silently ignore everyone who is not an admin.
  if (!(await isAdmin(env, message.from.id))) return

  if (message.text?.trim().toLowerCase().split('@')[0] === '/status') {
    await sendMessage(env, message.chat.id, await buildStatusText(env))
  } else if (message.audio) {
    await processAudioMessage(env, message, message.audio)
  } else if (message.document?.mime_type?.startsWith('audio/')) {
    await sendMessage(
      env,
      message.chat.id,
      '🚨 wav-подобное: Telegram прислал этот файл без длительности — бот не может его принять. Перекодируй в mp3 и перешли ещё раз.',
    )
  }
}
