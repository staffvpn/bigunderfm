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
  from?: { id: number; username?: string; first_name?: string }
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

// ---------- open label: demos from artists ----------

export const DEMO_FOLDER = 'show-demo'
export const DEMO_LIKES = 5
const DEMO_MIN_SECONDS = 60
const DEMO_MAX_SECONDS = 7 * 60
const DEMO_HELP =
  'BIGUNDER FM принимает демо.\n\n' +
  'Пришли сюда один трек файлом (mp3 или m4a, до 20 МБ, от 1 до 7 минут). Укажи в файле имя артиста и название.\n\n' +
  'Что дальше: команда слушает трек, и если он подходит, он выходит в DEMO HOUR каждую ночь с 01:00 до 02:00 по Москве. ' +
  `Слушатели ставят лайки. ${DEMO_LIKES} лайков, и трек попадает в основную ротацию радио.\n\n` +
  'Присылай только свою музыку. Один трек в сутки.'

/** What a new listener sees: the radio first, demos as a quiet second line. */
async function sendWelcome(env: Env, chatId: number): Promise<void> {
  await callTelegram(env, 'sendMessage', {
    chat_id: chatId,
    text: 'BIGUNDER FM. Independent Hip-Hop Radio, 24/7.\n\nЖми «Слушать», чтобы открыть эфир.\n\nДелаешь музыку? Отправь /demo, и твой трек может попасть в эфир.',
    reply_markup: { inline_keyboard: [[{ text: 'Слушать', web_app: { url: 'https://bigunderfm.pages.dev/' } }]] },
  })
}

async function adminIds(env: Env): Promise<number[]> {
  const { results } = await env.DB.prepare('select telegram_user_id from admins').all<{ telegram_user_id: number }>()
  return results.map((r) => Number(r.telegram_user_id))
}

async function processDemoMessage(env: Env, message: TelegramMessage, audio: TelegramAudio): Promise<void> {
  const chatId = message.chat.id
  const from = message.from!
  if (!audio.duration || audio.duration < DEMO_MIN_SECONDS || audio.duration > DEMO_MAX_SECONDS) {
    await sendMessage(env, chatId, 'Трек должен быть от 1 до 7 минут. Миксы и отрывки не принимаем.')
    return
  }
  const contentType = audioContentType(audio.file_name, audio.mime_type)
  if (!contentType) {
    await sendMessage(env, chatId, 'Формат не подходит. Нужен mp3 или m4a.')
    return
  }
  if (audio.file_size && audio.file_size > TELEGRAM_DOWNLOAD_LIMIT) {
    await sendMessage(env, chatId, 'Файл больше 20 МБ. Пришли mp3 поменьше.')
    return
  }
  const dayAgo = new Date(Date.now() - 24 * 3600_000).toISOString()
  const recent = await env.DB.prepare("select 1 as ok from demos where tg_user_id = ? and created_at > ? and status != 'rejected'")
    .bind(from.id, dayAgo)
    .first()
  if (recent) {
    await sendMessage(env, chatId, 'Сегодня ты уже присылал демо. Следующий трек можно отправить через сутки.')
    return
  }
  const title = audio.title?.trim()
  const artist = audio.performer?.trim()
  if (!title || !artist) {
    await sendMessage(env, chatId, 'В файле не указаны артист и название. Заполни их (в свойствах файла или при отправке) и пришли ещё раз.')
    return
  }

  const fileInfo = await callTelegram(env, 'getFile', { file_id: audio.file_id })
  const telegramFilePath = fileInfo?.result?.file_path
  const fileRes = telegramFilePath ? await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${telegramFilePath}`) : null
  if (!fileRes?.ok) {
    await sendMessage(env, chatId, 'Не получилось скачать файл. Попробуй отправить ещё раз.')
    return
  }
  const bytes = await fileRes.arrayBuffer()
  const key = buildTrackKey(audio.file_name)
  const trackId = crypto.randomUUID()
  try {
    await env.MEDIA.put(key, bytes, { httpMetadata: { contentType } })
    const position = await nextPlaylistPosition(env)
    await env.DB.batch([
      // Off until an admin lets it on air.
      env.DB.prepare(
        'insert into tracks (id, title, artist, file_path, duration_seconds, file_size_bytes, is_enabled, created_at) values (?, ?, ?, ?, ?, ?, 0, ?)',
      ).bind(trackId, title.slice(0, 120), artist.slice(0, 120), key, audio.duration, audio.file_size ?? bytes.byteLength, nowIso()),
      env.DB.prepare('insert into playlist_items (id, track_id, position) values (?, ?, ?)').bind(crypto.randomUUID(), trackId, position),
      env.DB.prepare('insert into demos (track_id, tg_user_id, username, status, created_at) values (?, ?, ?, ?, ?)').bind(
        trackId,
        from.id,
        from.username ?? null,
        'pending',
        nowIso(),
      ),
    ])
  } catch (err) {
    await env.MEDIA.delete(key).catch(() => {})
    console.error('demo upload failed', err)
    await sendMessage(env, chatId, 'Не получилось принять трек. Попробуй ещё раз позже.')
    return
  }

  await sendMessage(env, chatId, `Демо принято: ${artist} — ${title}. Команда послушает и ответит здесь.`)
  const sender = from.username ? `@${from.username}` : (from.first_name ?? `id ${from.id}`)
  for (const admin of await adminIds(env)) {
    await callTelegram(env, 'sendAudio', {
      chat_id: admin,
      audio: audio.file_id,
      caption: `ДЕМО от ${sender}\n${artist} — ${title}`,
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'В эфир', callback_data: `demo:ok:${trackId}` },
            { text: 'Отклонить', callback_data: `demo:no:${trackId}` },
          ],
        ],
      },
    })
  }
}

async function handleDemoDecision(env: Env, query: any): Promise<void> {
  const [, verdict, trackId] = String(query.data ?? '').split(':')
  const answer = (text: string) => callTelegram(env, 'answerCallbackQuery', { callback_query_id: query.id, text })
  if (!(await isAdmin(env, query.from?.id))) return void (await answer('Только для админов'))
  const demo = await env.DB.prepare(
    'select d.tg_user_id, d.status, t.title, t.artist, t.file_path from demos d left join tracks t on t.id = d.track_id where d.track_id = ?',
  )
    .bind(trackId)
    .first<{ tg_user_id: number; status: string; title: string | null; artist: string | null; file_path: string | null }>()
  if (!demo || demo.status !== 'pending' || !demo.file_path) return void (await answer('По этому демо уже решили'))
  const name = `${demo.artist} — ${demo.title}`
  if (verdict === 'ok') {
    await env.DB.batch([
      env.DB.prepare('update tracks set is_enabled = 1 where id = ?').bind(trackId),
      env.DB.prepare('insert or ignore into folder_tracks (folder_id, track_id) values (?, ?)').bind(DEMO_FOLDER, trackId),
      env.DB.prepare("update demos set status = 'demo', decided_at = ? where track_id = ?").bind(nowIso(), trackId),
    ])
    await answer('В эфире с ближайшего DEMO HOUR')
    await sendMessage(
      env,
      demo.tg_user_id,
      `Твой трек ${name} взяли в DEMO HOUR. Он звучит каждую ночь с 01:00 до 02:00 по Москве. ` +
        `Зови своих слушать и лайкать: ${DEMO_LIKES} лайков, и трек попадёт в основную ротацию BIGUNDER FM.`,
    )
  } else {
    await env.DB.batch([
      env.DB.prepare('delete from tracks where id = ?').bind(trackId),
      env.DB.prepare("update demos set status = 'rejected', decided_at = ? where track_id = ?").bind(nowIso(), trackId),
    ])
    await env.MEDIA.delete(demo.file_path).catch(() => {})
    await answer('Отклонено')
    await sendMessage(env, demo.tg_user_id, `Трек ${name} в этот раз не взяли. Присылай следующий, слушаем всё.`)
  }
  if (query.message) {
    await callTelegram(env, 'editMessageCaption', {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      caption: `${query.message.caption ?? name}\n\n${verdict === 'ok' ? 'ВЗЯЛИ В DEMO HOUR' : 'ОТКЛОНЕНО'}`,
    })
  }
}

/** A like just landed: a demo with enough of them moves into the main rotation. */
export async function promoteDemoIfLiked(env: Env, trackId: string): Promise<void> {
  const demo = await env.DB.prepare("select tg_user_id from demos where track_id = ? and status = 'demo'").bind(trackId).first<{ tg_user_id: number }>()
  if (!demo) return
  const likes = await env.DB.prepare('select count(*) as n from track_likes where track_id = ?').bind(trackId).first<{ n: number }>()
  if ((likes?.n ?? 0) < DEMO_LIKES) return
  const track = await env.DB.prepare('select title, artist from tracks where id = ?').bind(trackId).first<{ title: string; artist: string }>()
  await env.DB.batch([
    // Out of the demo folder: an unfiled track plays in every day part.
    env.DB.prepare('delete from folder_tracks where folder_id = ? and track_id = ?').bind(DEMO_FOLDER, trackId),
    env.DB.prepare("update demos set status = 'promoted', decided_at = ? where track_id = ?").bind(nowIso(), trackId),
  ])
  const name = track ? `${track.artist} — ${track.title}` : 'трек'
  await sendMessage(env, demo.tg_user_id, `${name} набрал ${DEMO_LIKES} лайков и теперь в основной ротации BIGUNDER FM. Поздравляем.`)
  for (const admin of await adminIds(env)) await sendMessage(env, admin, `Демо ${name} набрало ${DEMO_LIKES} лайков и перешло в ротацию (лежит в «Без папки»).`)
}

export async function handleBotUpdate(update: any, env: Env): Promise<void> {
  if (update?.callback_query?.data?.startsWith('demo:')) {
    await handleDemoDecision(env, update.callback_query)
    return
  }
  const message: TelegramMessage | undefined = update?.message
  if (!message?.from) return
  if (!(await isAdmin(env, message.from.id))) {
    // Everyone else: the open label. Private chats only.
    if (message.chat.id !== message.from.id) return
    if (message.audio) await processDemoMessage(env, message, message.audio)
    else if (message.document?.mime_type?.startsWith('audio/')) await sendMessage(env, message.chat.id, 'Пришли трек как аудио в mp3 или m4a, а не документом.')
    else {
      const text = message.text?.trim() ?? ''
      // "Прислать демо" in the app opens the bot as /start demo; /demo works too.
      if (/^\/start\s+demo\b/.test(text) || /^\/demo\b/.test(text)) await sendMessage(env, message.chat.id, DEMO_HELP)
      else if (/^\/start\b/.test(text)) await sendWelcome(env, message.chat.id)
    }
    return
  }

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
