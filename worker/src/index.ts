import type { Env } from './env'
import { handleBotUpdate, callTelegram } from './bot'
import { signJwt, verifyJwt, type Claims } from './jwt'
import { verifyInitData } from './telegramAuth'
import { CORS_HEADERS, audioContentType, buildMediaKey, buildTrackKey, imageContentType, json, nowIso, safeEqual, sleep } from './util'

export { Presence } from './presence'

const JWT_TTL_SECONDS = 12 * 3600
const MAX_TRACK_BYTES = 50 * 1024 * 1024
const MAX_COVER_BYTES = 5 * 1024 * 1024
const MAX_EVENT_IMAGE_BYTES = 5 * 1024 * 1024
const DEFAULT_SHOW_NAME = 'LOCAL SELECTS'
const SAMPLE_RETENTION_DAYS = 90
// Telegram allows ~30 msg/s; also keeps one request under the Free plan's subrequest cap.
const NOTIFY_CHUNK = 40
const NOTIFY_MAX_LENGTH = 1000

function isFile(v: unknown): v is File {
  return typeof v === 'object' && v !== null && 'arrayBuffer' in v && 'name' in v
}

interface TrackRow {
  id: string
  title: string
  artist: string
  file_path: string
  cover_path: string | null
  duration_seconds: number
  file_size_bytes: number
  is_enabled: number
  position: number
}

function toEntry(r: TrackRow) {
  return {
    position: r.position,
    track: {
      id: r.id,
      title: r.title,
      artist: r.artist,
      filePath: r.file_path,
      coverPath: r.cover_path,
      durationSeconds: r.duration_seconds,
      fileSizeBytes: r.file_size_bytes,
      isEnabled: r.is_enabled === 1,
    },
  }
}

const TRACK_SELECT = `select t.id, t.title, t.artist, t.file_path, t.cover_path, t.duration_seconds,
  t.file_size_bytes, t.is_enabled, p.position
  from playlist_items p join tracks t on t.id = p.track_id`

async function listPlaylist(env: Env, includeDisabled: boolean): Promise<TrackRow[]> {
  const where = includeDisabled ? '' : ' where t.is_enabled = 1'
  const { results } = await env.DB.prepare(`${TRACK_SELECT}${where} order by p.position asc, p.created_at asc`).all<TrackRow>()
  return results
}

// ---------- auth ----------

async function requireAdmin(req: Request, env: Env): Promise<Claims | Response> {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  const claims = token ? await verifyJwt(token, env.JWT_SECRET) : null
  if (!claims || !claims.admin) return json({ error: 'not authorized' }, 403)
  // Re-check on every call so a removed admin loses access immediately.
  const row = await env.DB.prepare('select 1 as ok from admins where telegram_user_id = ?').bind(Number(claims.sub)).first()
  if (!row) return json({ error: 'not authorized' }, 403)
  return claims
}

async function handleAuth(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { initData?: string } | null
  if (!body?.initData) return json({ error: 'initData is required' }, 400)

  const { valid, telegramUserId } = await verifyInitData(body.initData, env.TELEGRAM_BOT_TOKEN)
  if (!valid || telegramUserId === null) return json({ isAdmin: false })

  const adminRow = await env.DB.prepare('select 1 as ok from admins where telegram_user_id = ?').bind(telegramUserId).first()
  const isAdmin = Boolean(adminRow)

  await env.DB.prepare('insert into login_events (telegram_user_id, is_admin, created_at) values (?, ?, ?)')
    .bind(telegramUserId, isAdmin ? 1 : 0, nowIso())
    .run()
    .catch((err) => console.error('login_events insert failed', err))

  const token = await signJwt(
    { sub: String(telegramUserId), admin: isAdmin, exp: Math.floor(Date.now() / 1000) + JWT_TTL_SECONDS },
    env.JWT_SECRET,
  )
  return json({ isAdmin, token })
}

// ---------- public ----------

async function handleShowName(env: Env): Promise<Response> {
  const row = await env.DB.prepare("select value from settings where key = 'show_name'").first<{ value: string }>()
  return json({ name: row?.value?.trim() || DEFAULT_SHOW_NAME })
}

// ---------- admin: library ----------

async function handleUpload(req: Request, env: Env): Promise<Response> {
  const form = await req.formData().catch(() => null)
  const file = form?.get('file')
  if (!form || !isFile(file)) return json({ error: 'file is required' }, 400)

  const title = String(form.get('title') ?? '').trim()
  const artist = String(form.get('artist') ?? '').trim() || 'Unknown Artist'
  const duration = Number(form.get('duration'))
  if (!title) return json({ error: 'title is required' }, 400)
  // A zero-length track is unplayable dead weight in the rotation.
  if (!Number.isFinite(duration) || duration <= 0) return json({ error: 'не удалось определить длительность' }, 400)
  if (file.size > MAX_TRACK_BYTES) return json({ error: 'файл больше 50 МБ' }, 413)
  const contentType = audioContentType(file.name, file.type)
  if (!contentType) return json({ error: 'формат не поддерживается — нужен mp3, wav или m4a' }, 415)

  const cover = form.get('cover')
  if (isFile(cover) && cover.size > MAX_COVER_BYTES) return json({ error: 'обложка больше 5 МБ' }, 413)

  const fileKey = buildTrackKey(file.name)
  let coverKey: string | null = null
  try {
    await env.MEDIA.put(fileKey, file.stream(), { httpMetadata: { contentType } })
    if (isFile(cover) && cover.size > 0) {
      coverKey = `covers/${crypto.randomUUID()}.jpg`
      await env.MEDIA.put(coverKey, cover.stream(), { httpMetadata: { contentType: cover.type || 'image/jpeg' } })
    }
    const pos = await env.DB.prepare('select coalesce(max(position), 0) + 1 as p from playlist_items').first<{ p: number }>()
    const trackId = crypto.randomUUID()
    await env.DB.batch([
      env.DB.prepare(
        'insert into tracks (id, title, artist, file_path, cover_path, duration_seconds, file_size_bytes, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(trackId, title, artist, fileKey, coverKey, duration, file.size, nowIso()),
      env.DB.prepare('insert into playlist_items (id, track_id, position) values (?, ?, ?)').bind(
        crypto.randomUUID(),
        trackId,
        pos?.p ?? 1,
      ),
    ])
    return json({ ok: true, id: trackId })
  } catch (err) {
    // Roll back whatever this attempt already stored so nothing is orphaned in R2.
    await env.MEDIA.delete(fileKey).catch(() => {})
    if (coverKey) await env.MEDIA.delete(coverKey).catch(() => {})
    return json({ error: (err as Error).message }, 500)
  }
}

/**
 * Partial update: any of isEnabled / title / artist, whichever the caller
 * sends. Used both for the enable/disable toggle and for editing a track's
 * metadata after upload (bot uploads in particular often can't set a real
 * artist at upload time).
 */
async function handleUpdateTrack(req: Request, env: Env, id: string): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { isEnabled?: boolean; title?: string; artist?: string } | null
  if (!body || (body.isEnabled === undefined && body.title === undefined && body.artist === undefined)) {
    return json({ error: 'nothing to update' }, 400)
  }

  const sets: string[] = []
  const values: unknown[] = []

  if (body.isEnabled !== undefined) {
    if (typeof body.isEnabled !== 'boolean') return json({ error: 'isEnabled must be a boolean' }, 400)
    sets.push('is_enabled = ?')
    values.push(body.isEnabled ? 1 : 0)
  }
  if (body.title !== undefined) {
    const title = String(body.title).trim()
    if (!title) return json({ error: 'название не может быть пустым' }, 400)
    sets.push('title = ?')
    values.push(title)
  }
  if (body.artist !== undefined) {
    // Same fallback as a fresh upload — an empty field means "unknown", not a blank name.
    sets.push('artist = ?')
    values.push(String(body.artist).trim() || 'Unknown Artist')
  }

  values.push(id)
  const { meta } = await env.DB.prepare(`update tracks set ${sets.join(', ')} where id = ?`)
    .bind(...values)
    .run()
  if (meta.changes === 0) return json({ error: 'not found' }, 404)
  return json({ ok: true })
}

async function handleDelete(env: Env, id: string): Promise<Response> {
  const track = await env.DB.prepare('select file_path, cover_path from tracks where id = ?')
    .bind(id)
    .first<{ file_path: string; cover_path: string | null }>()
  if (!track) return json({ error: 'not found' }, 404)
  // playlist_items rows go with it (ON DELETE CASCADE).
  await env.DB.prepare('delete from tracks where id = ?').bind(id).run()
  const keys = [track.file_path, ...(track.cover_path ? [track.cover_path] : [])]
  await env.MEDIA.delete(keys)
  return json({ ok: true })
}

async function handleOrder(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { ids?: string[] } | null
  if (!Array.isArray(body?.ids) || body.ids.some((x) => typeof x !== 'string')) return json({ error: 'ids is required' }, 400)
  // One atomic batch: position 1..N in the given order.
  await env.DB.batch(
    body.ids.map((trackId, i) => env.DB.prepare('update playlist_items set position = ? where track_id = ?').bind(i + 1, trackId)),
  )
  return json({ ok: true })
}

async function handleSetShowName(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { name?: string } | null
  const name = (body?.name ?? '').trim().slice(0, 60) || DEFAULT_SHOW_NAME
  await env.DB.prepare("insert into settings (key, value) values ('show_name', ?) on conflict(key) do update set value = excluded.value")
    .bind(name)
    .run()
  return json({ name })
}

// ---------- events / schedule ----------

interface EventRow {
  id: string
  title: string
  description: string
  event_at: string
  image_path: string | null
}

function toEventEntry(env: Env, r: EventRow) {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    eventAt: r.event_at,
    imageUrl: r.image_path ? `${env.R2_PUBLIC_BASE}/${r.image_path}` : null,
  }
}

/** Listeners' feed: only events that haven't happened yet, soonest first. */
async function handleListEvents(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare('select * from events where event_at >= ? order by event_at asc')
    .bind(nowIso())
    .all<EventRow>()
  return json({ events: results.map((r) => toEventEntry(env, r)) })
}

/** Admin view: every event, past included, for editing/cleanup. */
async function handleAdminListEvents(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare('select * from events order by event_at asc').all<EventRow>()
  return json({ events: results.map((r) => toEventEntry(env, r)) })
}

function parseEventAt(raw: unknown): Date | null {
  const date = new Date(String(raw ?? ''))
  return Number.isNaN(date.getTime()) ? null : date
}

async function handleCreateEvent(req: Request, env: Env): Promise<Response> {
  const form = await req.formData().catch(() => null)
  if (!form) return json({ error: 'invalid form' }, 400)

  const title = String(form.get('title') ?? '').trim()
  if (!title) return json({ error: 'название не может быть пустым' }, 400)
  const description = String(form.get('description') ?? '').trim()
  const eventAt = parseEventAt(form.get('eventAt'))
  if (!eventAt) return json({ error: 'неверная дата и время' }, 400)

  const image = form.get('image')
  let imageKey: string | null = null
  if (isFile(image) && image.size > 0) {
    if (image.size > MAX_EVENT_IMAGE_BYTES) return json({ error: 'картинка больше 5 МБ' }, 413)
    const contentType = imageContentType(image.name, image.type)
    if (!contentType) return json({ error: 'формат картинки не поддерживается — нужен jpg, png или webp' }, 415)
    imageKey = buildMediaKey(image.name, 'events/')
    await env.MEDIA.put(imageKey, image.stream(), { httpMetadata: { contentType } })
  }

  const id = crypto.randomUUID()
  const now = nowIso()
  try {
    await env.DB.prepare(
      'insert into events (id, title, description, event_at, image_path, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(id, title, description, eventAt.toISOString(), imageKey, now, now)
      .run()
    return json({ ok: true, id })
  } catch (err) {
    if (imageKey) await env.MEDIA.delete(imageKey).catch(() => {})
    return json({ error: (err as Error).message }, 500)
  }
}

async function handleUpdateEvent(req: Request, env: Env, id: string): Promise<Response> {
  const form = await req.formData().catch(() => null)
  if (!form) return json({ error: 'invalid form' }, 400)

  const existing = await env.DB.prepare('select image_path from events where id = ?')
    .bind(id)
    .first<{ image_path: string | null }>()
  if (!existing) return json({ error: 'not found' }, 404)

  const sets: string[] = []
  const values: unknown[] = []

  if (form.has('title')) {
    const title = String(form.get('title') ?? '').trim()
    if (!title) return json({ error: 'название не может быть пустым' }, 400)
    sets.push('title = ?')
    values.push(title)
  }
  if (form.has('description')) {
    sets.push('description = ?')
    values.push(String(form.get('description') ?? '').trim())
  }
  if (form.has('eventAt')) {
    const eventAt = parseEventAt(form.get('eventAt'))
    if (!eventAt) return json({ error: 'неверная дата и время' }, 400)
    sets.push('event_at = ?')
    values.push(eventAt.toISOString())
  }

  // Either a new image replaces the old one, or removeImage=1 clears it —
  // never both; a real file always wins if somehow both are sent.
  let newImageKey: string | null = null
  let oldImageToDelete: string | null = null
  const image = form.get('image')
  if (isFile(image) && image.size > 0) {
    if (image.size > MAX_EVENT_IMAGE_BYTES) return json({ error: 'картинка больше 5 МБ' }, 413)
    const contentType = imageContentType(image.name, image.type)
    if (!contentType) return json({ error: 'формат картинки не поддерживается — нужен jpg, png или webp' }, 415)
    newImageKey = buildMediaKey(image.name, 'events/')
    await env.MEDIA.put(newImageKey, image.stream(), { httpMetadata: { contentType } })
    sets.push('image_path = ?')
    values.push(newImageKey)
    if (existing.image_path) oldImageToDelete = existing.image_path
  } else if (form.get('removeImage') === '1' && existing.image_path) {
    sets.push('image_path = ?')
    values.push(null)
    oldImageToDelete = existing.image_path
  }

  if (sets.length === 0) {
    if (newImageKey) await env.MEDIA.delete(newImageKey).catch(() => {})
    return json({ error: 'nothing to update' }, 400)
  }
  sets.push('updated_at = ?')
  values.push(nowIso())
  values.push(id)

  try {
    await env.DB.prepare(`update events set ${sets.join(', ')} where id = ?`)
      .bind(...values)
      .run()
  } catch (err) {
    if (newImageKey) await env.MEDIA.delete(newImageKey).catch(() => {})
    return json({ error: (err as Error).message }, 500)
  }
  if (oldImageToDelete) await env.MEDIA.delete(oldImageToDelete).catch(() => {})
  return json({ ok: true })
}

async function handleDeleteEvent(env: Env, id: string): Promise<Response> {
  const row = await env.DB.prepare('select image_path from events where id = ?')
    .bind(id)
    .first<{ image_path: string | null }>()
  if (!row) return json({ error: 'not found' }, 404)
  await env.DB.prepare('delete from events where id = ?').bind(id).run()
  if (row.image_path) await env.MEDIA.delete(row.image_path)
  return json({ ok: true })
}

// ---------- admin: stats / actions ----------

async function onlineCount(env: Env): Promise<number> {
  const stub = env.PRESENCE.get(env.PRESENCE.idFromName('room'))
  const res = await stub.fetch('https://presence/count')
  return ((await res.json()) as { count: number }).count
}

async function handleStats(req: Request, env: Env): Promise<Response> {
  const tz = Math.max(-840, Math.min(840, Math.trunc(Number(new URL(req.url).searchParams.get('tz')) || 0)))
  const modifier = `${tz >= 0 ? '+' : '-'}${Math.abs(tz)} minutes`
  const since = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString()

  const peakSql = 'select coalesce(max(listeners), 0) as p from listener_samples where sampled_at >= ?'
  const [day, week, month, hours, total, storage, playlist] = await env.DB.batch([
    env.DB.prepare(peakSql).bind(since(1)),
    env.DB.prepare(peakSql).bind(since(7)),
    env.DB.prepare(peakSql).bind(since(30)),
    env.DB.prepare(
      "select cast(strftime('%H', created_at, ?) as integer) as h, count(*) as c from login_events group by h",
    ).bind(modifier),
    env.DB.prepare('select count(*) as c from login_events'),
    env.DB.prepare('select coalesce(sum(file_size_bytes), 0) as b from tracks'),
    env.DB.prepare(
      'select count(*) as n, coalesce(sum(t.duration_seconds), 0) as d from playlist_items p join tracks t on t.id = p.track_id where t.is_enabled = 1',
    ),
  ])
  const first = (r: D1Result, key: string): number => Number((r.results[0] as Record<string, unknown> | undefined)?.[key] ?? 0)

  const byHour = new Array<number>(24).fill(0)
  for (const row of hours.results as { h: number; c: number }[]) byHour[row.h] = row.c

  return json({
    peaks: { day: first(day, 'p'), week: first(week, 'p'), month: first(month, 'p') },
    hourlyOpens: byHour.map((count, hour) => ({ hour, count })),
    totalOpens: first(total, 'c'),
    storageUsedBytes: first(storage, 'b'),
    trackCount: first(playlist, 'n'),
    rotationSeconds: first(playlist, 'd'),
    online: await onlineCount(env).catch(() => 0),
  })
}

async function handleSkip(env: Env): Promise<Response> {
  try {
    const res = await fetch(`${env.SKIP_BRIDGE_URL}/skip`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.SKIP_BRIDGE_SECRET}` },
    })
    const text = await res.text()
    if (!res.ok) return json({ error: text || `skip bridge returned ${res.status}` }, 502)
    return json({ ok: true })
  } catch (err) {
    return json({ error: (err as Error).message }, 502)
  }
}

/**
 * Broadcasts a bot message to everyone who ever opened the app. Works in chunks
 * (client passes `offset` and keeps calling until `next` is null) so one request
 * stays within Workers limits however many recipients there are.
 */
async function handleNotify(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => null)) as
    | { text?: string; offset?: number; totals?: { sent: number; failed: number } }
    | null
  const text = typeof body?.text === 'string' ? body.text.trim() : ''
  if (!text) return json({ error: 'Пустое сообщение' }, 400)
  if (text.length > NOTIFY_MAX_LENGTH) return json({ error: `Слишком длинное сообщение (максимум ${NOTIFY_MAX_LENGTH})` }, 400)
  const offset = Math.max(0, Math.trunc(body?.offset ?? 0))

  const totalRow = await env.DB.prepare('select count(distinct telegram_user_id) as n from login_events').first<{ n: number }>()
  const total = totalRow?.n ?? 0
  const { results } = await env.DB.prepare(
    'select distinct telegram_user_id as id from login_events order by telegram_user_id limit ? offset ?',
  )
    .bind(NOTIFY_CHUNK, offset)
    .all<{ id: number }>()

  let sent = 0
  let failed = 0
  for (const { id } of results) {
    const res = await callTelegram(env, 'sendMessage', { chat_id: id, text })
    if (res?.ok) sent++
    else failed++
    await sleep(40)
  }

  const next = offset + results.length < total && results.length > 0 ? offset + results.length : null
  if (next === null) {
    const t = body?.totals ?? { sent: 0, failed: 0 }
    await env.DB.prepare('insert into notification_log (message, sent_count, failed_count, created_at) values (?, ?, ?, ?)')
      .bind(text, t.sent + sent, t.failed + failed, nowIso())
      .run()
  }
  return json({ ok: true, sent, failed, total, next })
}

// ---------- VPS / migration (shared-secret) ----------

async function handleInternal(req: Request, env: Env, path: string): Promise<Response> {
  if (!safeEqual(req.headers.get('X-Internal-Secret') ?? '', env.INTERNAL_SECRET)) return json({ error: 'forbidden' }, 403)

  // The VPS playlist sync reads the enabled rotation from here (no database password on the server).
  if (req.method === 'GET' && path === '/internal/playlist.tsv') {
    const rows = await listPlaylist(env, false)
    const clean = (s: string) => s.replace(/[\t\r\n]+/g, ' ')
    const body = rows.map((r) => `${r.file_path}\t${clean(r.title)}\t${clean(r.artist)}`).join('\n')
    return new Response(body, { headers: { ...CORS_HEADERS, 'Content-Type': 'text/tab-separated-values; charset=utf-8' } })
  }

  // Used once to move files from Supabase Storage into R2.
  if (req.method === 'PUT' && path.startsWith('/internal/import/')) {
    const key = decodeURIComponent(path.slice('/internal/import/'.length))
    if (!key) return json({ error: 'key required' }, 400)
    await env.MEDIA.put(key, req.body, { httpMetadata: { contentType: req.headers.get('Content-Type') ?? 'application/octet-stream' } })
    return json({ ok: true, key })
  }
  if (req.method === 'HEAD' && path.startsWith('/internal/import/')) {
    const key = decodeURIComponent(path.slice('/internal/import/'.length))
    const head = await env.MEDIA.head(key)
    return new Response(null, { status: head ? 200 : 404, headers: CORS_HEADERS })
  }
  return json({ error: 'not found' }, 404)
}

// ---------- router ----------

async function route(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url)
  const path = url.pathname
  const m = req.method

  if (m === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS })

  if (path === '/api/health') return json({ ok: true, time: nowIso() })

  // public
  if (m === 'POST' && path === '/api/auth/telegram') return handleAuth(req, env)
  if (m === 'GET' && path === '/api/playlist') return json({ entries: (await listPlaylist(env, false)).map(toEntry) })
  if (m === 'GET' && path === '/api/show-name') return handleShowName(env)
  if (m === 'GET' && path === '/api/events') return handleListEvents(env)
  if (path === '/api/presence') {
    const stub = env.PRESENCE.get(env.PRESENCE.idFromName('room'))
    return stub.fetch(req)
  }

  // telegram bot webhook
  if (m === 'POST' && path === '/bot/webhook') {
    if (!safeEqual(req.headers.get('X-Telegram-Bot-Api-Secret-Token') ?? '', env.WEBHOOK_SECRET)) return new Response('forbidden', { status: 403 })
    const update = await req.json().catch(() => null)
    // Always 200 (Telegram retries otherwise and could replay a half-finished upload); work continues after the reply.
    ctx.waitUntil(handleBotUpdate(update, env).catch((err) => console.error('bot update failed', err)))
    return new Response('ok')
  }

  if (path.startsWith('/internal/')) return handleInternal(req, env, path)

  // admin
  if (path.startsWith('/api/admin/')) {
    const auth = await requireAdmin(req, env)
    if (auth instanceof Response) return auth

    if (m === 'GET' && path === '/api/admin/library') return json({ entries: (await listPlaylist(env, true)).map(toEntry) })
    if (m === 'POST' && path === '/api/admin/tracks') return handleUpload(req, env)
    if (m === 'PUT' && path === '/api/admin/order') return handleOrder(req, env)
    if (m === 'PUT' && path === '/api/admin/show-name') return handleSetShowName(req, env)
    if (m === 'GET' && path === '/api/admin/stats') return handleStats(req, env)
    // Cheap (no database): the dashboard polls this every few seconds.
    if (m === 'GET' && path === '/api/admin/online') return json({ online: await onlineCount(env).catch(() => 0) })
    if (m === 'POST' && path === '/api/admin/skip') return handleSkip(env)
    if (m === 'POST' && path === '/api/admin/notify') return handleNotify(req, env)
    if (m === 'GET' && path === '/api/admin/events') return handleAdminListEvents(env)
    if (m === 'POST' && path === '/api/admin/events') return handleCreateEvent(req, env)

    const track = path.match(/^\/api\/admin\/tracks\/([0-9a-f-]{36})$/)
    if (track && m === 'PATCH') return handleUpdateTrack(req, env, track[1])
    if (track && m === 'DELETE') return handleDelete(env, track[1])

    const event = path.match(/^\/api\/admin\/events\/([0-9a-f-]{36})$/)
    if (event && m === 'PATCH') return handleUpdateEvent(req, env, event[1])
    if (event && m === 'DELETE') return handleDeleteEvent(env, event[1])
  }

  return json({ error: 'not found' }, 404)
}

// ---------- cron: sample the listener count once a minute ----------

async function sampleListeners(env: Env): Promise<void> {
  let listeners: number
  try {
    const res = await fetch(env.ICECAST_STATUS_URL, { signal: AbortSignal.timeout(8000) })
    const source = ((await res.json()) as any)?.icestats?.source
    // No source = stream is down, which is not "0 listeners" — do not record it.
    if (!source) return
    listeners = Number(source.listeners ?? 0)
  } catch {
    return
  }
  await env.DB.prepare('insert or replace into listener_samples (sampled_at, listeners) values (?, ?)').bind(nowIso(), listeners).run()
  // Housekeeping once an hour keeps the table small.
  if (new Date().getUTCMinutes() === 0) {
    await env.DB.prepare('delete from listener_samples where sampled_at < ?')
      .bind(new Date(Date.now() - SAMPLE_RETENTION_DAYS * 86_400_000).toISOString())
      .run()
  }
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await route(req, env, ctx)
    } catch (err) {
      console.error(err)
      return json({ error: 'internal error' }, 500)
    }
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(sampleListeners(env))
  },
}
