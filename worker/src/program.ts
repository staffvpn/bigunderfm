// Database side of the autorotation: loads the library for rotation.ts,
// keeps the on-air log (`program`) planned ahead, and answers "what is on
// now / next" for the app and the admin tab.
import type { Env } from './env'
import { nowIso } from './util'
import {
  NEW_FOR_MS,
  activeSlot,
  nextSlotChange,
  pickNext,
  type PlayKind,
  type RFolder,
  type RPlayed,
  type RSlot,
  type RTrack,
} from './rotation'

// Planned this far ahead, topped up once less than REPLAN_LEFT_MS remains.
// Planning reads the whole library, so it must not run every minute (D1's
// free plan counts rows read).
const PLAN_AHEAD_MS = 60 * 60_000
const REPLAN_LEFT_MS = 25 * 60_000
const KEEP_MS = 7 * 86_400_000
const RECENT_PLAYS = 30
// Auto-hits: the tracks with the most hearts over the last month.
const AUTO_HIT_DAYS = 30
const AUTO_HIT_MIN_HEARTS = 3
const AUTO_HIT_MAX = 15
// Liquidsoap's queue is kept this long while the VPS is on air.
const VPS_QUEUE_TARGET = 2

interface Library {
  tracks: RTrack[]
  folders: RFolder[]
  slots: RSlot[]
  filePaths: Map<string, string>
}

type SlotRow = { id: string; folder_id: string; title: string; days: string; start_minute: number; end_minute: number; priority: number }

function toSlot(r: SlotRow): RSlot {
  return { id: r.id, folderId: r.folder_id, title: r.title, days: r.days, startMinute: r.start_minute, endMinute: r.end_minute, priority: r.priority }
}

async function loadLibrary(env: Env): Promise<Library> {
  const [tracksRes, linksRes, foldersRes, slotsRes] = await env.DB.batch([
    env.DB.prepare(
      `select t.id, t.title, t.artist, t.file_path, t.duration_seconds, t.kind, t.is_hit, t.created_at
       from playlist_items p join tracks t on t.id = p.track_id where t.is_enabled = 1`,
    ),
    env.DB.prepare('select folder_id, track_id from folder_tracks'),
    env.DB.prepare('select id, name, kind from folders'),
    env.DB.prepare('select id, folder_id, title, days, start_minute, end_minute, priority from schedule_slots'),
  ])
  const byTrack = new Map<string, string[]>()
  for (const l of linksRes.results as { folder_id: string; track_id: string }[]) {
    const list = byTrack.get(l.track_id) ?? []
    list.push(l.folder_id)
    byTrack.set(l.track_id, list)
  }
  const filePaths = new Map<string, string>()
  const seen = new Set<string>()
  const tracks: RTrack[] = []
  for (const r of tracksRes.results as {
    id: string
    title: string
    artist: string
    file_path: string
    duration_seconds: number
    kind: string
    is_hit: number
    created_at: string
  }[]) {
    if (seen.has(r.id)) continue
    seen.add(r.id)
    filePaths.set(r.id, r.file_path)
    tracks.push({
      id: r.id,
      title: r.title,
      artist: r.artist,
      duration: Math.max(1, r.duration_seconds),
      kind: r.kind === 'jingle' ? 'jingle' : 'track',
      isHit: r.is_hit === 1,
      createdAt: Date.parse(r.created_at) || 0,
      folderIds: byTrack.get(r.id) ?? [],
    })
  }
  return {
    tracks,
    folders: (foldersRes.results as { id: string; name: string; kind: string }[]).map((f) => ({
      id: f.id,
      name: f.name,
      kind: f.kind === 'show' ? 'show' : 'mood',
    })),
    slots: (slotsRes.results as SlotRow[]).map(toSlot),
    filePaths,
  }
}

export async function autoHitIds(env: Env, now: number): Promise<string[]> {
  const since = new Date(now - AUTO_HIT_DAYS * 86_400_000).toISOString().slice(0, 10)
  const { results } = await env.DB.prepare(
    'select track_id, sum(hearts) as h from track_hearts where day >= ? group by track_id having h >= ? order by h desc limit ?',
  )
    .bind(since, AUTO_HIT_MIN_HEARTS, AUTO_HIT_MAX)
    .all<{ track_id: string }>()
  return results.map((r) => r.track_id)
}

interface Planner {
  lib: Library
  recent: RPlayed[]
  lastPlayed: Map<string, number>
  autoHits: Set<string>
}

async function loadPlanner(env: Env, now: number): Promise<Planner> {
  const lib = await loadLibrary(env)
  const [lastRes, recentRes] = await env.DB.batch([
    env.DB.prepare('select track_id, max(starts_at) as m from program where starts_at > ? group by track_id').bind(
      new Date(now - KEEP_MS).toISOString(),
    ),
    env.DB.prepare('select track_id, starts_at, kind from program order by starts_at desc limit ?').bind(RECENT_PLAYS),
  ])
  const lastPlayed = new Map<string, number>()
  for (const r of lastRes.results as { track_id: string; m: string }[]) lastPlayed.set(r.track_id, Date.parse(r.m))
  const recent = (recentRes.results as { track_id: string; starts_at: string; kind: string }[])
    .map((r) => ({ trackId: r.track_id, startsAt: Date.parse(r.starts_at), kind: r.kind as PlayKind }))
    .reverse()
  return { lib, recent, lastPlayed, autoHits: new Set(await autoHitIds(env, now)) }
}

interface Planned {
  trackId: string
  startsAt: number
  endsAt: number
  kind: PlayKind
  slotTitle: string
}

function planOne(p: Planner, at: number): Planned | null {
  const pick = pickNext({
    tracks: p.lib.tracks,
    folders: p.lib.folders,
    slots: p.lib.slots,
    recent: p.recent,
    lastPlayed: p.lastPlayed,
    autoHitIds: p.autoHits,
    now: at,
  })
  if (!pick) return null
  p.recent.push({ trackId: pick.track.id, startsAt: at, kind: pick.kind })
  if (p.recent.length > RECENT_PLAYS) p.recent.shift()
  p.lastPlayed.set(pick.track.id, at)
  return { trackId: pick.track.id, startsAt: at, endsAt: at + pick.track.duration * 1000, kind: pick.kind, slotTitle: pick.slot?.title ?? '' }
}

function insertPlanned(env: Env, rows: Planned[]): D1PreparedStatement[] {
  return rows.map((r) =>
    env.DB.prepare('insert into program (track_id, starts_at, ends_at, kind, slot_title) values (?, ?, ?, ?, ?)').bind(
      r.trackId,
      new Date(r.startsAt).toISOString(),
      new Date(r.endsAt).toISOString(),
      r.kind,
      r.slotTitle,
    ),
  )
}

/**
 * Keeps the timeline planned about an hour ahead. Cheap when there is nothing
 * to do (one indexed row). Tracks follow each other back to back; if the
 * timeline ran dry (first run, or the VPS was on air for a while) it restarts
 * from now.
 */
export async function planAhead(env: Env, now: number, force = false): Promise<void> {
  const tailRow = await env.DB.prepare('select ends_at from program order by starts_at desc limit 1').first<{ ends_at: string }>()
  const tail = tailRow ? Date.parse(tailRow.ends_at) : 0
  if (!force && tail > now + REPLAN_LEFT_MS) return

  const planner = await loadPlanner(env, now)
  const rows: Planned[] = []
  let cursor = tail > now ? tail : now
  while (cursor < now + PLAN_AHEAD_MS && rows.length < 90) {
    const next = planOne(planner, cursor)
    if (!next) break
    rows.push(next)
    cursor = next.endsAt
  }
  if (rows.length === 0) return
  await env.DB.batch([
    ...insertPlanned(env, rows),
    env.DB.prepare('delete from program where starts_at < ?').bind(new Date(now - KEEP_MS).toISOString()),
  ])
}

/** Ends the current track now and replans from here (admin "next track" without the VPS). */
export async function skipCurrent(env: Env, now: number): Promise<void> {
  const iso = new Date(now).toISOString()
  await env.DB.batch([
    env.DB.prepare('delete from program where starts_at > ?').bind(iso),
    env.DB.prepare('update program set ends_at = ? where starts_at <= ? and ends_at > ?').bind(iso, iso, iso),
  ])
  await planAhead(env, now, true)
}

// ---------- admin "play next" without the VPS ----------
// Queued tracks sit on the timeline right after the current one, in the
// order they were added; the rotation continues after the last of them.

export interface QueuedItem {
  id: number
  trackId: string
}

export async function listQueued(env: Env, now: number): Promise<QueuedItem[]> {
  const { results } = await env.DB.prepare("select id, track_id from program where kind = 'queued' and starts_at > ? order by starts_at")
    .bind(new Date(now).toISOString())
    .all<{ id: number; track_id: string }>()
  return results.map((r) => ({ id: r.id, trackId: r.track_id }))
}

/** Rebuilds everything after the current track: the given queue first, then the rotation. */
async function setQueued(env: Env, now: number, trackIds: string[]): Promise<void> {
  const iso = new Date(now).toISOString()
  const current = await env.DB.prepare('select ends_at from program where starts_at <= ? and ends_at > ? order by starts_at desc limit 1')
    .bind(iso, iso)
    .first<{ ends_at: string }>()
  let cursor = current ? Date.parse(current.ends_at) : now
  const rows: Planned[] = []
  for (const id of trackIds) {
    const t = await env.DB.prepare('select duration_seconds from tracks where id = ? and is_enabled = 1').bind(id).first<{ duration_seconds: number }>()
    if (!t) continue
    const endsAt = cursor + Math.max(1, t.duration_seconds) * 1000
    rows.push({ trackId: id, startsAt: cursor, endsAt, kind: 'queued', slotTitle: '' })
    cursor = endsAt
  }
  await env.DB.batch([env.DB.prepare('delete from program where starts_at > ?').bind(iso), ...insertPlanned(env, rows)])
  await planAhead(env, now, true)
}

export async function queueNext(env: Env, now: number, trackId: string): Promise<void> {
  const queued = await listQueued(env, now)
  await setQueued(env, now, [...queued.map((q) => q.trackId), trackId])
}

export async function unqueue(env: Env, now: number, itemId: number): Promise<void> {
  const queued = await listQueued(env, now)
  await setQueued(env, now, queued.filter((q) => q.id !== itemId).map((q) => q.trackId))
}

/** Drops what was planned but has not started (the library or the grid changed). */
export async function replanFuture(env: Env, now: number): Promise<void> {
  await env.DB.prepare('delete from program where starts_at > ?').bind(new Date(now).toISOString()).run()
  await planAhead(env, now, true)
}

export interface ProgramItem {
  id: number
  startsAt: string
  endsAt: string
  kind: PlayKind
  isNew: boolean
  track: { id: string; title: string; artist: string; filePath: string; durationSeconds: number }
}

export interface ProgramView {
  now: string
  vpsUp: boolean
  slot: { title: string; endsAt: string | null } | null
  nextSlot: { title: string; startsAt: string } | null
  items: ProgramItem[]
}

type ItemRow = {
  id: number
  track_id: string
  starts_at: string
  ends_at: string
  kind: string
  title: string
  artist: string
  file_path: string
  duration_seconds: number
  created_at: string
}

async function loadItems(env: Env, now: number): Promise<ItemRow[]> {
  const { results } = await env.DB.prepare(
    `select p.id, p.track_id, p.starts_at, p.ends_at, p.kind, t.title, t.artist, t.file_path, t.duration_seconds, t.created_at
     from program p join tracks t on t.id = p.track_id
     where p.ends_at > ? and t.is_enabled = 1 order by p.starts_at limit 6`,
  )
    .bind(new Date(now).toISOString())
    .all<ItemRow>()
  return results
}

export async function isVpsUp(env: Env): Promise<boolean> {
  const row = await env.DB.prepare("select value from settings where key = 'vps_up'").first<{ value: string }>()
  return row?.value === '1'
}

/** What the app needs: the current and next few tracks with their times, and the grid. */
export async function programView(env: Env, now: number): Promise<ProgramView> {
  let items = await loadItems(env, now)
  if (items.length === 0 || Date.parse(items[0].starts_at) > now + 5000) {
    await planAhead(env, now, items.length === 0)
    items = await loadItems(env, now)
  }
  const [slotsRes, showsRes, vps] = await Promise.all([
    env.DB.prepare('select id, folder_id, title, days, start_minute, end_minute, priority from schedule_slots').all<SlotRow>(),
    // Which show folders have anything in them (an empty show doesn't air).
    env.DB.prepare(
      "select f.id from folders f where f.kind = 'show' and exists (select 1 from folder_tracks ft join tracks t on t.id = ft.track_id where ft.folder_id = f.id and t.is_enabled = 1)",
    ).all<{ id: string }>(),
    isVpsUp(env),
  ])
  const slots = slotsRes.results.map(toSlot)
  const filled = new Set(showsRes.results.map((r) => r.id))
  const usable = (s: RSlot) => !s.folderId.startsWith('show-') || filled.has(s.folderId)
  const slot = activeSlot(slots, now, usable)
  const change = nextSlotChange(slots, now, usable)
  return {
    now: new Date(now).toISOString(),
    vpsUp: vps,
    slot: slot ? { title: slot.title, endsAt: change ? new Date(change.at).toISOString() : null } : null,
    nextSlot: change?.slot ? { title: change.slot.title, startsAt: new Date(change.at).toISOString() } : null,
    items: items.map((r) => ({
      id: r.id,
      startsAt: r.starts_at,
      endsAt: r.ends_at,
      kind: r.kind as PlayKind,
      isNew: now - (Date.parse(r.created_at) || 0) < NEW_FOR_MS && r.kind !== 'jingle',
      track: { id: r.track_id, title: r.title, artist: r.artist, filePath: r.file_path, durationSeconds: r.duration_seconds },
    })),
  }
}

/** The track on the planned timeline right now (the air while the VPS is down). */
export async function programNow(env: Env, now: number): Promise<{ trackId: string; artist: string; title: string; kind: string; startedAt: string } | null> {
  const iso = new Date(now).toISOString()
  const row = await env.DB.prepare(
    `select p.track_id, p.starts_at, p.kind, t.title, t.artist from program p join tracks t on t.id = p.track_id
     where p.starts_at <= ? and p.ends_at > ? order by p.starts_at desc limit 1`,
  )
    .bind(iso, iso)
    .first<{ track_id: string; starts_at: string; kind: string; title: string; artist: string }>()
  return row ? { trackId: row.track_id, artist: row.artist, title: row.title, kind: row.kind, startedAt: row.starts_at } : null
}

/** Stream title in the same shape Liquidsoap reports it. */
export function airTitle(artist: string, title: string): string {
  return artist && artist !== 'Unknown Artist' ? `${artist} - ${title}` : title
}

// ---------- hearts -> auto-hits ----------

async function trackOnAir(env: Env, now: number): Promise<string | null> {
  if (await isVpsUp(env)) {
    // On the VPS the stream title is the truth; match it back to a track.
    const last = await env.DB.prepare('select title from play_history order by id desc limit 1').first<{ title: string }>()
    if (!last) return null
    const row = await env.DB.prepare(
      "select id from tracks where kind = 'track' and (artist || ' - ' || title = ?1 or title = ?1) limit 1",
    )
      .bind(last.title)
      .first<{ id: string }>()
    return row?.id ?? null
  }
  const cur = await programNow(env, now)
  return cur && cur.kind !== 'jingle' ? cur.trackId : null
}

/** Credits hearts to whatever is on air (called by the Presence object). */
export async function recordHearts(env: Env, hearts: number): Promise<void> {
  if (hearts <= 0) return
  const now = Date.now()
  const trackId = await trackOnAir(env, now)
  if (!trackId) return
  await env.DB.prepare(
    'insert into track_hearts (track_id, day, hearts) values (?, ?, ?) on conflict(track_id, day) do update set hearts = hearts + excluded.hearts',
  )
    .bind(trackId, nowIso().slice(0, 10), hearts)
    .run()
}

// ---------- VPS on air: feed Liquidsoap's queue with the same picks ----------

export function trackUri(env: Env, t: { title: string; artist: string; filePath: string }): string {
  // Same annotate format as sync-playlist.sh, so the stream title looks the same.
  const esc = (s: string) => s.replace(/[\r\n]+/g, ' ').replace(/"/g, '\\"')
  const artist = t.artist === 'Unknown Artist' ? '' : t.artist
  return `annotate:title="${esc(t.title)}",artist="${esc(artist)}":${env.R2_PUBLIC_BASE}/${t.filePath}`
}

/**
 * While the VPS is streaming, Liquidsoap would just loop its playlist file.
 * Keeping a couple of our picks in its "play next" queue makes it follow the
 * rotation instead; the playlist stays as its safety net.
 */
export async function feedVpsQueue(
  env: Env,
  now: number,
  queueLength: number,
  push: (uri: string) => Promise<unknown>,
): Promise<void> {
  const need = VPS_QUEUE_TARGET - queueLength
  if (need <= 0) return
  const planner = await loadPlanner(env, now)
  const tailRow = await env.DB.prepare('select ends_at from program order by starts_at desc limit 1').first<{ ends_at: string }>()
  let cursor = Math.max(now, tailRow ? Date.parse(tailRow.ends_at) : 0)
  const byId = new Map(planner.lib.tracks.map((t) => [t.id, t]))
  for (let i = 0; i < need; i++) {
    const next = planOne(planner, cursor)
    if (!next) return
    const t = byId.get(next.trackId)!
    await push(trackUri(env, { title: t.title, artist: t.artist, filePath: planner.lib.filePaths.get(t.id)! }))
    await env.DB.batch(insertPlanned(env, [next]))
    cursor = next.endsAt
  }
}
