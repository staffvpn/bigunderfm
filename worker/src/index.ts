import type { Env } from './env'
import { handleBotUpdate, callTelegram } from './bot'
import { signJwt, verifyJwt, type Claims } from './jwt'
import { verifyInitData } from './telegramAuth'
import { CORS_HEADERS, audioContentType, buildMediaKey, buildTrackKey, imageContentType, json, nowIso, safeEqual, sleep } from './util'

import {
  airTitle,
  autoHitIds,
  feedVpsQueue,
  isVpsUp,
  listUpcoming,
  planAhead,
  programNow,
  programView,
  cutDeadCurrent,
  parseAirNames,
  queueAt,
  removeUpcoming,
  replanFuture,
  skipCurrent,
} from './program'

export { Presence } from './presence'
export { LiveRoom } from './liveRoom'

const JWT_TTL_SECONDS = 12 * 3600
const MAX_TRACK_BYTES = 50 * 1024 * 1024
const MAX_COVER_BYTES = 5 * 1024 * 1024
const MAX_EVENT_IMAGE_BYTES = 5 * 1024 * 1024
const DEFAULT_SHOW_NAME = 'LOCAL SELECTS'
const SAMPLE_RETENTION_DAYS = 90
const PLAY_HISTORY_KEEP = 100
const PLAY_HISTORY_SHOWN = 15
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
  kind: string
  is_hit: number
  created_at: string
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
      kind: r.kind === 'jingle' || r.kind === 'promo' ? r.kind : 'track',
      isHit: r.is_hit === 1,
      createdAt: r.created_at,
    },
  }
}

const TRACK_SELECT = `select t.id, t.title, t.artist, t.file_path, t.cover_path, t.duration_seconds,
  t.file_size_bytes, t.is_enabled, p.position, t.kind, t.is_hit, t.created_at
  from playlist_items p join tracks t on t.id = p.track_id`

async function listPlaylist(env: Env, includeDisabled: boolean): Promise<TrackRow[]> {
  // Announcements air only by timer, so listeners' playlists never include them.
  const where = includeDisabled ? '' : " where t.is_enabled = 1 and t.kind != 'promo'"
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

/** Any signed-in listener, admin or not — every real Telegram launch already
    gets a token from handleAuth below, so this doesn't need its own login
    step. Used by the "remind me" button: it needs a verified telegram_user_id,
    nothing admin-only. */
async function requireUser(req: Request, env: Env): Promise<Claims | Response> {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  const claims = token ? await verifyJwt(token, env.JWT_SECRET) : null
  if (!claims) return json({ error: 'нужно открыть приложение в Telegram' }, 401)
  return claims
}

async function handleAuth(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { initData?: string } | null
  if (!body?.initData) return json({ error: 'initData is required' }, 400)

  const { valid, telegramUserId } = await verifyInitData(body.initData, env.TELEGRAM_BOT_TOKEN)
  if (!valid || telegramUserId === null) return json({ isAdmin: false })

  const adminRow = await env.DB.prepare('select 1 as ok from admins where telegram_user_id = ?').bind(telegramUserId).first()
  const isAdmin = Boolean(adminRow)
  const now = nowIso()

  await env.DB.prepare('insert into login_events (telegram_user_id, is_admin, created_at) values (?, ?, ?)')
    .bind(telegramUserId, isAdmin ? 1 : 0, now)
    .run()
    .catch((err) => console.error('login record failed', err))

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
  const body = (await req.json().catch(() => null)) as
    | { isEnabled?: boolean; title?: string; artist?: string; isHit?: boolean; kind?: string }
    | null
  if (
    !body ||
    (body.isEnabled === undefined && body.title === undefined && body.artist === undefined && body.isHit === undefined && body.kind === undefined)
  ) {
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

  if (body.isHit !== undefined) {
    sets.push('is_hit = ?')
    values.push(body.isHit ? 1 : 0)
  }
  if (body.kind !== undefined) {
    if (body.kind !== 'track' && body.kind !== 'jingle' && body.kind !== 'promo') return json({ error: 'kind must be track, jingle or promo' }, 400)
    sets.push('kind = ?')
    values.push(body.kind)
  }

  values.push(id)
  const { meta } = await env.DB.prepare(`update tracks set ${sets.join(', ')} where id = ?`)
    .bind(...values)
    .run()
  if (meta.changes === 0) return json({ error: 'not found' }, 404)
  // A track taken off air must not stay in what is already planned.
  if (body.isEnabled === false || body.kind !== undefined) await replanFuture(env, Date.now())
  return json({ ok: true })
}

async function handleDelete(env: Env, id: string): Promise<Response> {
  const track = await env.DB.prepare('select file_path, cover_path from tracks where id = ?')
    .bind(id)
    .first<{ file_path: string; cover_path: string | null }>()
  if (!track) return json({ error: 'not found' }, 404)
  // playlist_items and folder_tracks rows go with it (ON DELETE CASCADE).
  await env.DB.prepare('delete from tracks where id = ?').bind(id).run()
  await replanFuture(env, Date.now())
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

/** Listeners' feed: every event, oldest first — same list the admin sees. */
async function handleListEvents(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare('select * from events order by event_at asc').all<EventRow>()
  return json({ events: results.map((r) => toEventEntry(env, r)) })
}

/** Admin view: every event, past included, for editing/cleanup. */
async function handleAdminListEvents(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare('select * from events order by event_at asc').all<EventRow>()
  return json({ events: results.map((r) => toEventEntry(env, r)) })
}

function parseEventAt(raw: unknown): Date | null {
  const str = String(raw ?? '')
  // Require an explicit UTC/offset marker. A naive "YYYY-MM-DDTHH:MM" string
  // is ambiguous about whose timezone it means, and the JS Date constructor
  // silently reads it as this runtime's own local time (always UTC on
  // Cloudflare Workers) — that mismatch is exactly what once saved an
  // admin's Moscow-time entry three hours off. Reject it outright instead
  // of guessing.
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(str)) return null
  const date = new Date(str)
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
  await env.DB.prepare('delete from event_reminders where event_id = ?').bind(id).run()
  if (row.image_path) await env.MEDIA.delete(row.image_path)
  return json({ ok: true })
}

/**
 * "Напомнить" button on a Schedule card. Any signed-in listener (not just
 * admins) can subscribe; idempotent, so pressing it again on an event
 * they're already subscribed to just re-sends the confirmation rather than
 * erroring or creating a duplicate row. The actual reminder is sent later
 * by sendDueReminders() below, close to the event's start.
 */
async function handleRemindMe(env: Env, eventId: string, telegramUserId: number): Promise<Response> {
  const event = await env.DB.prepare('select title, event_at from events where id = ?')
    .bind(eventId)
    .first<{ title: string; event_at: string }>()
  if (!event) return json({ error: 'событие не найдено' }, 404)
  if (new Date(event.event_at).getTime() <= Date.now()) return json({ error: 'событие уже прошло' }, 400)

  await env.DB.prepare(
    'insert into event_reminders (event_id, telegram_user_id, created_at) values (?, ?, ?) on conflict(event_id, telegram_user_id) do nothing',
  )
    .bind(eventId, telegramUserId, nowIso())
    .run()

  // Best-effort: telling them now also confirms the button actually worked,
  // separately from whether the bot could reach them (see `messaged` below —
  // it can't if they've never pressed Start on the bot itself).
  const sendResult = await callTelegram(env, 'sendMessage', {
    chat_id: telegramUserId,
    text: `🔔 Напомню о «${event.title}» — не пропусти!`,
  }).catch(() => null)

  return json({ ok: true, messaged: Boolean(sendResult?.ok) })
}

// ---------- admin: stats / actions ----------

async function handleStats(env: Env): Promise<Response> {
  const since = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString()

  const peakSql = 'select coalesce(max(listeners), 0) as p from listener_samples where sampled_at >= ?'
  const [day, week, month, storage, playlist] = await env.DB.batch([
    env.DB.prepare(peakSql).bind(since(1)),
    env.DB.prepare(peakSql).bind(since(7)),
    env.DB.prepare(peakSql).bind(since(30)),
    env.DB.prepare('select coalesce(sum(file_size_bytes), 0) as b from tracks'),
    env.DB.prepare(
      'select count(*) as n, coalesce(sum(t.duration_seconds), 0) as d from playlist_items p join tracks t on t.id = p.track_id where t.is_enabled = 1',
    ),
  ])
  const first = (r: D1Result, key: string): number => Number((r.results[0] as Record<string, unknown> | undefined)?.[key] ?? 0)

  return json({
    peaks: { day: first(day, 'p'), week: first(week, 'p'), month: first(month, 'p') },
    storageUsedBytes: first(storage, 'b'),
    trackCount: first(playlist, 'n'),
    rotationSeconds: first(playlist, 'd'),
  })
}

async function handleSkip(env: Env): Promise<Response> {
  try {
    if (env.LIVE_SERVER === '0') throw new Error('no server')
    const res = await fetch(`${env.SKIP_BRIDGE_URL}/skip`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.SKIP_BRIDGE_SECRET}` },
      signal: AbortSignal.timeout(6000),
    })
    if (res.ok) return json({ ok: true })
  } catch {
    // VPS unreachable - skip on the planned timeline instead (below).
  }
  // Without the VPS the app plays the planned timeline, so skipping means
  // ending the current entry now; listeners move on at their next check.
  await skipCurrent(env, Date.now())
  await dropProgramCache(env)
  return json({ ok: true, mode: 'program' })
}

// ---------- rotation: folders, hits, grid (admin) ----------

/** What the admin edits about the air: the listener-facing names of the day parts, and the shows. */
async function handleAdminAir(env: Env): Promise<Response> {
  const [names, shows] = await Promise.all([
    env.DB.prepare("select value from settings where key = 'air_names'").first<{ value: string }>(),
    env.DB.prepare(
      "select s.id, s.title, s.days, s.start_minute, s.end_minute from schedule_slots s join folders f on f.id = s.folder_id where f.kind = 'show' order by s.start_minute",
    ).all<{ id: string; title: string; days: string; start_minute: number; end_minute: number }>(),
  ])
  return json({
    names: parseAirNames(names?.value),
    shows: shows.results.map((r) => ({ id: r.id, title: r.title, days: r.days, startMinute: r.start_minute, endMinute: r.end_minute })),
  })
}

async function handleSetAirNames(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body) return json({ error: 'names required' }, 400)
  const names = parseAirNames(JSON.stringify(body))
  await env.DB.prepare("insert into settings (key, value) values ('air_names', ?) on conflict(key) do update set value = excluded.value")
    .bind(JSON.stringify(names))
    .run()
  await dropProgramCache(env)
  return json({ names })
}

async function handleSetShow(req: Request, env: Env, slotId: string): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { title?: string; days?: string; startMinute?: number; endMinute?: number } | null
  const title = String(body?.title ?? '').trim().slice(0, 60)
  const days = [...new Set(String(body?.days ?? '').replace(/[^1-7]/g, ''))].sort().join('')
  const start = Math.trunc(Number(body?.startMinute))
  const end = Math.trunc(Number(body?.endMinute))
  const minuteOk = (n: number) => Number.isFinite(n) && n >= 0 && n < 1440
  if (!title || !days || !minuteOk(start) || !minuteOk(end) || start === end) return json({ error: 'Проверьте название, дни и время' }, 400)
  const slot = await env.DB.prepare(
    "select s.folder_id from schedule_slots s join folders f on f.id = s.folder_id where s.id = ? and f.kind = 'show'",
  )
    .bind(slotId)
    .first<{ folder_id: string }>()
  if (!slot) return json({ error: 'Шоу не найдено' }, 404)
  await env.DB.batch([
    env.DB.prepare('update schedule_slots set title = ?, days = ?, start_minute = ?, end_minute = ? where id = ?').bind(title, days, start, end, slotId),
    env.DB.prepare('update folders set name = ? where id = ?').bind(title, slot.folder_id),
  ])
  await replanFuture(env, Date.now())
  await dropProgramCache(env)
  return json({ ok: true })
}

async function handleRotation(env: Env): Promise<Response> {
  const [folders, links, slots] = await env.DB.batch([
    env.DB.prepare('select id, name, kind from folders order by position'),
    env.DB.prepare('select folder_id, track_id from folder_tracks'),
    env.DB.prepare('select id, folder_id, title, days, start_minute, end_minute, priority from schedule_slots order by priority, start_minute'),
  ])
  const memberships: Record<string, string[]> = {}
  for (const l of links.results as { folder_id: string; track_id: string }[]) (memberships[l.track_id] ??= []).push(l.folder_id)
  const [likes, timers] = await env.DB.batch([
    env.DB.prepare('select track_id, count(*) as n from track_likes group by track_id'),
    env.DB.prepare('select id, track_id, fire_at, minute from track_timers order by coalesce(fire_at, \'\'), minute'),
  ])
  return json({
    folders: folders.results,
    memberships,
    likes: Object.fromEntries((likes.results as { track_id: string; n: number }[]).map((r) => [r.track_id, r.n])),
    timers: (timers.results as { id: number; track_id: string; fire_at: string | null; minute: number | null }[]).map((r) => ({
      id: r.id,
      trackId: r.track_id,
      fireAt: r.fire_at,
      minute: r.minute,
    })),
    autoHitIds: await autoHitIds(env, Date.now()),
    slots: (slots.results as Record<string, unknown>[]).map((r) => ({
      id: r.id,
      folderId: r.folder_id,
      title: r.title,
      days: r.days,
      startMinute: r.start_minute,
      endMinute: r.end_minute,
      priority: r.priority,
    })),
  })
}

async function handleSetTrackFolders(req: Request, env: Env, trackId: string): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { folderIds?: string[] } | null
  if (!Array.isArray(body?.folderIds) || body.folderIds.some((x) => typeof x !== 'string')) return json({ error: 'folderIds is required' }, 400)
  const known = new Set((await env.DB.prepare('select id from folders').all<{ id: string }>()).results.map((r) => r.id))
  const ids = [...new Set(body.folderIds)].filter((id) => known.has(id))
  await env.DB.batch([
    env.DB.prepare('delete from folder_tracks where track_id = ?').bind(trackId),
    ...ids.map((id) => env.DB.prepare('insert into folder_tracks (folder_id, track_id) values (?, ?)').bind(id, trackId)),
  ])
  return json({ ok: true, folderIds: ids })
}

// ---------- timers (admin): a track at an exact Moscow time ----------

async function handleAddTimer(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { trackId?: string; time?: string; daily?: boolean } | null
  const m = /^(\d{1,2}):(\d{2})$/.exec(body?.time ?? '')
  if (!body?.trackId || !m || Number(m[1]) > 23 || Number(m[2]) > 59) return json({ error: 'Нужны трек и время ЧЧ:ММ' }, 400)
  const track = await env.DB.prepare('select id from tracks where id = ?').bind(body.trackId).first()
  if (!track) return json({ error: 'Трек не найден' }, 404)
  const minute = Number(m[1]) * 60 + Number(m[2])
  const now = Date.now()
  let fireAt: string | null = null
  if (!body.daily) {
    // The next time the Moscow clock (UTC+3) shows this time.
    const offset = 180 * 60_000
    const dayStart = Math.floor((now + offset) / 86_400_000) * 86_400_000 - offset
    let at = dayStart + minute * 60_000
    if (at <= now + 30_000) at += 86_400_000
    fireAt = new Date(at).toISOString()
  }
  await env.DB.prepare('insert into track_timers (track_id, fire_at, minute, created_at) values (?, ?, ?, ?)')
    .bind(body.trackId, fireAt, body.daily ? minute : null, nowIso())
    .run()
  await planAhead(env, now, true)
  await dropProgramCache(env)
  return json({ ok: true, fireAt })
}

async function handleDeleteTimer(env: Env, id: number): Promise<Response> {
  const row = await env.DB.prepare('select track_id from track_timers where id = ?').bind(id).first<{ track_id: string }>()
  if (!row) return json({ ok: true })
  await env.DB.batch([
    env.DB.prepare('delete from track_timers where id = ?').bind(id),
    // Its plays that have not started yet go too.
    env.DB.prepare("delete from program where kind = 'timer' and track_id = ? and starts_at > ?").bind(row.track_id, nowIso()),
  ])
  await replanFuture(env, Date.now())
  await dropProgramCache(env)
  return json({ ok: true })
}

// ---------- likes: one per person per track ----------

async function likeUser(req: Request, env: Env, device: unknown): Promise<string | null> {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  const claims = token ? await verifyJwt(token, env.JWT_SECRET) : null
  if (claims?.sub) return `tg:${claims.sub}`
  return typeof device === 'string' && /^[A-Za-z0-9-]{16,64}$/.test(device) ? `dev:${device}` : null
}

async function likeState(env: Env, trackId: string, user: string | null): Promise<{ count: number; liked: boolean }> {
  const [count, mine] = await env.DB.batch([
    env.DB.prepare('select count(*) as n from track_likes where track_id = ?').bind(trackId),
    env.DB.prepare('select 1 as ok from track_likes where track_id = ? and user_key = ?').bind(trackId, user ?? ''),
  ])
  return { count: Number((count.results[0] as { n: number } | undefined)?.n ?? 0), liked: mine.results.length > 0 }
}

async function handleGetLike(req: Request, env: Env, url: URL): Promise<Response> {
  const trackId = url.searchParams.get('trackId') ?? ''
  if (!trackId) return json({ error: 'trackId required' }, 400)
  return json(await likeState(env, trackId, await likeUser(req, env, url.searchParams.get('device'))))
}

async function handleLike(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { trackId?: string; device?: string } | null
  const user = await likeUser(req, env, body?.device)
  if (!body?.trackId || !user) return json({ error: 'trackId required' }, 400)
  const track = await env.DB.prepare("select id from tracks where id = ? and kind = 'track'").bind(body.trackId).first()
  if (!track) return json({ error: 'Трек не найден' }, 404)
  await env.DB.prepare('insert or ignore into track_likes (track_id, user_key, created_at) values (?, ?, ?)').bind(body.trackId, user, nowIso()).run()
  return json(await likeState(env, body.trackId, user))
}

/** The grid screen in one request: what just played (with this person's likes),
    what is on, what is next, and when the shows air. */
async function handleGrid(req: Request, env: Env, url: URL): Promise<Response> {
  const nowMs = Date.now()
  const iso = new Date(nowMs).toISOString()
  const [view, user, pastRes, showsRes] = await Promise.all([
    programView(env, nowMs),
    likeUser(req, env, url.searchParams.get('device')),
    env.DB.prepare(
      `select p.track_id, p.starts_at, t.title, t.artist from program p join tracks t on t.id = p.track_id
       where p.ends_at <= ? and t.kind = 'track' order by p.starts_at desc limit 4`,
    )
      .bind(iso)
      .all<{ track_id: string; starts_at: string; title: string; artist: string }>(),
    env.DB.prepare(
      "select s.title, s.days, s.start_minute from schedule_slots s join folders f on f.id = s.folder_id where f.kind = 'show' order by s.start_minute",
    ).all<{ title: string; days: string; start_minute: number }>(),
  ])
  const idx = view.items.findIndex((it) => Date.parse(it.startsAt) <= nowMs && Date.parse(it.endsAt) > nowMs)
  const current = idx >= 0 ? view.items[idx] : null
  const upcoming = view.items.slice(idx + 1).filter((it) => it.kind !== 'jingle' && it.kind !== 'timer').slice(0, 3)
  const next = upcoming[0] ?? null
  const likeable = !!current && current.kind !== 'jingle' && current.kind !== 'timer'
  const ids = [...new Set([...pastRes.results.map((r) => r.track_id), ...(likeable ? [current!.track.id] : [])])]
  const likes = new Map<string, { n: number; mine: number }>()
  if (ids.length) {
    const res = await env.DB.prepare(
      `select track_id, count(*) as n, sum(case when user_key = ? then 1 else 0 end) as mine from track_likes
       where track_id in (${ids.map(() => '?').join(',')}) group by track_id`,
    )
      .bind(user ?? '', ...ids)
      .all<{ track_id: string; n: number; mine: number }>()
    for (const r of res.results) likes.set(r.track_id, { n: Number(r.n), mine: Number(r.mine) })
  }
  const like = (id: string) => ({ likes: likes.get(id)?.n ?? 0, liked: (likes.get(id)?.mine ?? 0) > 0 })
  return json({
    now: iso,
    slot: view.slot?.label ?? null,
    current: current
      ? {
          trackId: likeable ? current.track.id : null,
          startsAt: current.startsAt,
          endsAt: current.endsAt,
          artist: current.track.artist,
          title: current.track.title,
          isNew: current.isNew,
          ...like(current.track.id),
        }
      : null,
    next: next ? { startsAt: next.startsAt, artist: next.track.artist, title: next.track.title } : null,
    upcoming: upcoming.map((it) => ({ startsAt: it.startsAt, artist: it.track.artist, title: it.track.title })),
    past: pastRes.results
      .reverse()
      .map((r) => ({ trackId: r.track_id, startsAt: r.starts_at, artist: r.artist, title: r.title, ...like(r.track_id) })),
    shows: showsRes.results.map((r) => ({ title: r.title, days: r.days, startMinute: r.start_minute })),
  })
}

/** Now / next / grid for the app. Cached a few seconds (every open app polls
    it); the clock in the answer is always fresh, since the app sets its own
    clock offset by it. */
async function handleProgram(env: Env, ctx: ExecutionContext): Promise<Response> {
  const cacheKey = new Request('https://cache.bigunderfm/program')
  const cached = await caches.default.match(cacheKey)
  let view: Awaited<ReturnType<typeof programView>>
  if (cached) {
    view = await cached.json()
  } else {
    view = await programView(env, Date.now())
    const store = json(view)
    store.headers.set('Cache-Control', 'public, max-age=5')
    ctx.waitUntil(caches.default.put(cacheKey, store))
  }
  return json({ ...view, now: nowIso() })
}

// ---------- play-next queue + live music level (Liquidsoap, through skip-bridge) ----------

async function bridge<T>(env: Env, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  if (env.LIVE_SERVER === '0') throw new Error('сервер эфира отключён, радио играет из облака')
  const res = await fetch(`${env.SKIP_BRIDGE_URL}${path}`, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bearer ${env.SKIP_BRIDGE_SECRET}`, 'Content-Type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  const data = (await res.json().catch(() => null)) as { error?: string } | null
  if (!res.ok) throw new Error(data?.error || `skip bridge returned ${res.status}`)
  return data as T
}

/** STUN plus our own TURN relay (coturn's REST-API scheme: username is
    "<expiry>:<user>", password is base64 HMAC-SHA1 of it), valid for 12 hours. */
async function iceServers(env: Env, userId: string): Promise<{ urls: string | string[]; username?: string; credential?: string }[]> {
  const username = `${Math.floor(Date.now() / 1000) + 12 * 3600}:${userId}`
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.TURN_SECRET), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(username)))
  const credential = btoa(String.fromCharCode(...sig))
  return [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: [`turn:${env.TURN_HOST}?transport=udp`, `turn:${env.TURN_HOST}?transport=tcp`], username, credential },
  ]
}

/** Turns a failed call to the radio server into a readable 502 for the admin UI. */
async function viaBridge(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn()
  } catch (err) {
    return json({ error: `Сервер эфира не ответил: ${(err as Error).message}` }, 502)
  }
}

/** The R2 key at the end of a Liquidsoap request URI ("annotate:...:<base>/<key>"). */
function trackKeyFromUri(env: Env, uri: string): string | null {
  const i = uri.lastIndexOf(`${env.R2_PUBLIC_BASE}/`)
  return i === -1 ? null : uri.slice(i + env.R2_PUBLIC_BASE.length + 1)
}

/** Listeners should see a changed timeline at their next check, not 5 s later. */
async function dropProgramCache(env: Env): Promise<void> {
  await caches.default.delete(new Request('https://cache.bigunderfm/program'))
  try {
    await env.PRESENCE.get(env.PRESENCE.idFromName('room')).fetch('https://presence/changed')
  } catch {
    // apps still catch up at their next (rare) check
  }
}

async function handleListQueue(env: Env): Promise<Response> {
  if (!(await isVpsUp(env))) {
    // Without the VPS the queue is the planned timeline itself: the next few
    // items in order, each with its start time.
    const upcoming = await listUpcoming(env, Date.now(), 12)
    const ids = [...new Set(upcoming.map((q) => q.trackId))]
    const rows = ids.length
      ? (
          await env.DB.prepare(`${TRACK_SELECT} where t.id in (${ids.map(() => '?').join(',')})`)
            .bind(...ids)
            .all<TrackRow>()
        ).results
      : []
    const byId = new Map(rows.map((r) => [r.id, r]))
    return json({
      mode: 'program',
      entries: upcoming.flatMap((q) => {
        const row = byId.get(q.trackId)
        return row ? [{ rid: q.id, startsAt: q.startsAt, airKind: q.kind, ...toEntry(row) }] : []
      }),
    })
  }
  const { items } = await bridge<{ items: { rid: number; uri: string }[] }>(env, '/queue')
  const keyed = items.map((it) => ({ rid: it.rid, key: trackKeyFromUri(env, it.uri) }))
  const keys = [...new Set(keyed.map((k) => k.key).filter((k): k is string => !!k))]
  const rows = keys.length
    ? (
        await env.DB.prepare(`${TRACK_SELECT} where t.file_path in (${keys.map(() => '?').join(',')})`)
          .bind(...keys)
          .all<TrackRow>()
      ).results
    : []
  const byKey = new Map(rows.map((r) => [r.file_path, r]))
  const entries = keyed.flatMap((k) => {
    const row = k.key ? byKey.get(k.key) : undefined
    return row ? [{ rid: k.rid, ...toEntry(row) }] : []
  })
  return json({ entries })
}

async function handleQueueTrack(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { trackId?: string; position?: number } | null
  if (!body?.trackId) return json({ error: 'trackId required' }, 400)
  const row = await env.DB.prepare(`${TRACK_SELECT} where t.id = ?`).bind(body.trackId).first<TrackRow>()
  if (!row) return json({ error: 'Трек не найден' }, 404)
  if (!(await isVpsUp(env))) {
    await queueAt(env, Date.now(), row.id, Number(body.position) || 1)
    await dropProgramCache(env)
    return json({ ok: true, mode: 'program' })
  }
  // Same annotate format as sync-playlist.sh, so the stream title looks the same.
  const esc = (s: string) => s.replace(/[\r\n]+/g, ' ').replace(/"/g, '\\"')
  const artist = row.artist === 'Unknown Artist' ? '' : row.artist
  const uri = `annotate:title="${esc(row.title)}",artist="${esc(artist)}":${env.R2_PUBLIC_BASE}/${row.file_path}`
  return json(await bridge(env, '/queue', { method: 'POST', body: { uri } }))
}

/** What plays after the current track, for the listener's "next track" line.
    Cached for a few seconds so listeners polling it don't all reach the VPS. */
async function handleUpNext(env: Env, ctx: ExecutionContext): Promise<Response> {
  const cacheKey = new Request('https://cache.bigunderfm/up-next')
  const cached = await caches.default.match(cacheKey)
  if (cached) return cached
  let key: string | null = null
  try {
    const { uri } = await bridge<{ uri: string }>(env, '/upnext')
    key = trackKeyFromUri(env, uri)
  } catch {
    // Unknown: the app falls back to the next track in playlist order.
  }
  const res = json({ filePath: key })
  res.headers.set('Cache-Control', 'public, max-age=10')
  ctx.waitUntil(caches.default.put(cacheKey, res.clone()))
  return res
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

  // The server reports its Cloudflare tunnel address here (listeners whose network or
  // VPN cannot reach the server directly use it for the stream).
  if (req.method === 'POST' && path === '/internal/stream-host') {
    const body = (await req.json().catch(() => null)) as { host?: string } | null
    const host = String(body?.host ?? '')
    if (!/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(host)) return json({ error: 'bad host' }, 400)
    await env.DB.prepare("insert into settings (key, value) values ('stream_tunnel', ?) on conflict(key) do update set value = excluded.value")
      .bind(host)
      .run()
    await dropProgramCache(env)
    return json({ ok: true })
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
  if (m === 'GET' && path === '/api/up-next') return handleUpNext(env, ctx)
  if (m === 'GET' && path === '/api/history') return handleHistory(env, ctx)
  if (m === 'GET' && path === '/api/program') return handleProgram(env, ctx)
  if (m === 'GET' && path === '/api/likes') return handleGetLike(req, env, url)
  if (m === 'GET' && path === '/api/grid') return handleGrid(req, env, url)
  if (m === 'POST' && path === '/api/likes') return handleLike(req, env)
  const remind = path.match(/^\/api\/events\/([0-9a-f-]{36})\/remind$/)
  if (remind && m === 'POST') {
    const auth = await requireUser(req, env)
    if (auth instanceof Response) return auth
    return handleRemindMe(env, remind[1], Number(auth.sub))
  }
  // Hosts' call signalling. Browsers can't put a header on a WebSocket, so the
  // session token comes in the query string; admins only.
  if (path === '/api/live/room') {
    const token = url.searchParams.get('token') ?? ''
    const claims = token ? await verifyJwt(token, env.JWT_SECRET) : null
    const isAdmin =
      claims?.admin &&
      (await env.DB.prepare('select 1 as ok from admins where telegram_user_id = ?').bind(Number(claims.sub)).first())
    if (!isAdmin) return json({ error: 'not authorized' }, 403)
    return env.LIVE_ROOM.get(env.LIVE_ROOM.idFromName('hosts')).fetch(req)
  }
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
    if (m === 'GET' && path === '/api/admin/stats') return handleStats(env)
    if (m === 'GET' && path === '/api/admin/fallback-status') return handleFallbackStatus(env)
    if (m === 'GET' && path === '/api/admin/rotation') return handleRotation(env)
    if (m === 'GET' && path === '/api/admin/air') return handleAdminAir(env)
    if (m === 'PUT' && path === '/api/admin/air-names') return handleSetAirNames(req, env)
    const showSlot = path.match(/^\/api\/admin\/shows\/([a-z0-9-]{1,60})$/)
    if (showSlot && m === 'PUT') return handleSetShow(req, env, showSlot[1])
    if (m === 'POST' && path === '/api/admin/timers') return handleAddTimer(req, env)
    const timerId = path.match(/^\/api\/admin\/timers\/(\d+)$/)
    if (timerId && m === 'DELETE') return handleDeleteTimer(env, Number(timerId[1]))
    const trackFolders = path.match(/^\/api\/admin\/tracks\/([0-9a-f-]{36})\/folders$/)
    if (trackFolders && m === 'PUT') return handleSetTrackFolders(req, env, trackFolders[1])
    // Cheap (no database): the dashboard polls this every few seconds.
    if (m === 'POST' && path === '/api/admin/skip') return handleSkip(env)
    if (m === 'GET' && path === '/api/admin/live') {
      return json({
        url: env.LIVE_INGEST_URL,
        password: env.LIVE_PASSWORD,
        slots: ['live1', 'live2', 'live3'],
        iceServers: await iceServers(env, auth.sub),
      })
    }
    if (m === 'GET' && path === '/api/admin/voice-gain') return viaBridge(async () => json(await bridge(env, '/voice-gain')))
    if (m === 'PUT' && path === '/api/admin/voice-gain') {
      const body = (await req.json().catch(() => null)) as { value?: number } | null
      const value = Number(body?.value)
      if (!Number.isFinite(value) || value < 0.5 || value > 6) return json({ error: 'value must be 0.5..6' }, 400)
      return viaBridge(async () => json(await bridge(env, '/voice-gain', { method: 'POST', body: { value } })))
    }
    if (m === 'GET' && path === '/api/admin/queue') return viaBridge(() => handleListQueue(env))
    if (m === 'POST' && path === '/api/admin/queue') return viaBridge(() => handleQueueTrack(req, env))
    const queued = path.match(/^\/api\/admin\/queue\/(\d+)$/)
    if (queued && m === 'DELETE') {
      if (!(await isVpsUp(env))) {
        await removeUpcoming(env, Date.now(), Number(queued[1]))
        await dropProgramCache(env)
        return json({ ok: true, mode: 'program' })
      }
      return viaBridge(async () => json(await bridge(env, '/queue/remove', { method: 'POST', body: { rid: Number(queued[1]) } })))
    }
    if (m === 'GET' && path === '/api/admin/music-volume') return viaBridge(async () => json(await bridge(env, '/music-volume')))
    if (m === 'PUT' && path === '/api/admin/music-volume') {
      const body = (await req.json().catch(() => null)) as { value?: number } | null
      const value = Number(body?.value)
      if (!Number.isFinite(value) || value < 0 || value > 1) return json({ error: 'value must be 0..1' }, 400)
      return viaBridge(async () => json(await bridge(env, '/music-volume', { method: 'POST', body: { value } })))
    }
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

// ---------- cron: event reminders + listener sampling, once a minute ----------

// How far ahead of an event's start its "напомнить" subscribers get messaged.
// Independent of EventTicker's 24h "coming soon" banner window on the
// frontend — this one is the actual nudge, so it's much closer to the event.
const REMINDER_LEAD_MS = 60 * 60 * 1000

async function sendDueReminders(env: Env): Promise<void> {
  const horizon = new Date(Date.now() + REMINDER_LEAD_MS).toISOString()
  const now = nowIso()
  const { results } = await env.DB.prepare(
    `select r.event_id, r.telegram_user_id, e.title
     from event_reminders r
     join events e on e.id = r.event_id
     where r.notified_at is null and e.event_at <= ? and e.event_at > ?`,
  )
    .bind(horizon, now)
    .all<{ event_id: string; telegram_user_id: number; title: string }>()

  for (const row of results) {
    await callTelegram(env, 'sendMessage', {
      chat_id: row.telegram_user_id,
      text: `🔔 Через час: «${row.title}» — не пропусти!`,
    }).catch(() => null)
    // Marked sent even if Telegram rejected it (e.g. the listener blocked the
    // bot) — retrying every minute for a delivery that will keep failing
    // isn't useful, and they already got a subscribe-time confirmation that
    // would have surfaced that same problem.
    await env.DB.prepare('update event_reminders set notified_at = ? where event_id = ? and telegram_user_id = ?')
      .bind(nowIso(), row.event_id, row.telegram_user_id)
      .run()
  }
}

/** Adds the track on air to play_history when it differs from the last one. */
async function recordPlayed(env: Env, title: string): Promise<void> {
  const last = await env.DB.prepare('select id, title from play_history order by id desc limit 1').first<{ id: number; title: string }>()
  if (last?.title === title) return
  const res = await env.DB.prepare('insert into play_history (title, played_at) values (?, ?)').bind(title, nowIso()).run()
  const id = Number(res.meta.last_row_id)
  if (id > PLAY_HISTORY_KEEP) await env.DB.prepare('delete from play_history where id <= ?').bind(id - PLAY_HISTORY_KEEP).run()
}

/** The listeners' "что играло": the latest tracks, newest first. Cached for
    half a minute, since it only changes when a track does. */
async function handleHistory(env: Env, ctx: ExecutionContext): Promise<Response> {
  const cacheKey = new Request('https://cache.bigunderfm/history')
  const cached = await caches.default.match(cacheKey)
  if (cached) return cached
  const { results } = await env.DB.prepare('select title, played_at from play_history order by id desc limit ?')
    .bind(PLAY_HISTORY_SHOWN)
    .all<{ title: string; played_at: string }>()
  const res = json({ items: results.map((r) => ({ title: r.title, playedAt: r.played_at })) })
  res.headers.set('Cache-Control', 'public, max-age=30')
  ctx.waitUntil(caches.default.put(cacheKey, res.clone()))
  return res
}

// ---------- air without the VPS ----------
// While the VPS is unreachable the app plays the planned timeline (program
// table, see program.ts) straight from R2. The same table tells admins what
// is on, and keeps "что играло" and the listener peaks going.

/** People with the app open right now (Presence durable object). */
async function appOpenCount(env: Env): Promise<number> {
  const stub = env.PRESENCE.get(env.PRESENCE.idFromName('room'))
  const res = await stub.fetch('https://presence/count')
  return Number(((await res.json()) as { count?: number }).count ?? 0)
}

async function handleFallbackStatus(env: Env): Promise<Response> {
  const [now, appOpen] = await Promise.all([programNow(env, Date.now()), appOpenCount(env)])
  return json({
    appOpen,
    title: now ? airTitle(now.artist, now.title) : null,
    trackStartedAt: now?.startedAt ?? null,
  })
}

async function setVpsUp(env: Env, up: boolean): Promise<boolean> {
  const prev = await env.DB.prepare("select value from settings where key = 'vps_up'").first<{ value: string }>()
  const was = prev?.value === '1'
  if (was !== up || !prev) {
    await env.DB.prepare("insert into settings (key, value) values ('vps_up', ?) on conflict(key) do update set value = excluded.value")
      .bind(up ? '1' : '0')
      .run()
  }
  return was
}

/** Once a minute: keep the air planned, and sample listeners / what played. */
async function sampleListeners(env: Env): Promise<void> {
  const nowMs = Date.now()
  let listeners: number
  let title: string
  let source: any = null
  try {
    if (env.LIVE_SERVER === '0') throw new Error('no server')
    const res = await fetch(env.ICECAST_STATUS_URL, { signal: AbortSignal.timeout(8000) })
    source = ((await res.json()) as any)?.icestats?.source
  } catch {
    source = null
  }
  const wasUp = await setVpsUp(env, Boolean(source))
  if (source) {
    listeners = Number(source.listeners ?? 0)
    title = typeof source.title === 'string' ? source.title.trim() : ''
    try {
      // The VPS just came back: what was planned for the app's own playback
      // will not air, so it must not count as played.
      if (!wasUp) await env.DB.prepare('delete from program where starts_at > ?').bind(new Date(nowMs).toISOString()).run()
      const { items } = await bridge<{ items: unknown[] }>(env, '/queue')
      await feedVpsQueue(env, nowMs, items.length, (uri) => bridge(env, '/queue', { method: 'POST', body: { uri } }))
    } catch (err) {
      console.error('feeding the VPS queue failed', err)
    }
  } else {
    // VPS down: the app plays the planned timeline. Icecast can't count
    // listeners then, so the number of people with the app open stands in.
    try {
      // Safety net: whatever happened to the track on air, the air goes on within a minute.
      if (await cutDeadCurrent(env, nowMs)) {
        await replanFuture(env, nowMs)
        await dropProgramCache(env)
      }
      await planAhead(env, nowMs)
      const now = await programNow(env, nowMs)
      title = now && now.kind !== 'jingle' ? airTitle(now.artist, now.title) : ''
      listeners = await appOpenCount(env)
    } catch (err) {
      console.error('planning failed', err)
      return
    }
  }
  if (title) await recordPlayed(env, title)
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
    ctx.waitUntil(sendDueReminders(env))
  },
}
