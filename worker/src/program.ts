// Database side of the autorotation: loads the library for rotation.ts,
// keeps the on-air log (`program`) planned ahead, and answers "what is on
// now / next" for the app and the admin tab.
import type { Env } from './env'
import {
  NEW_FOR_MS,
  STATION_UTC_OFFSET_MIN,
  activeSlot,
  nextSlotChange,
  pickNext,
  poolFor,
  type Pick,
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
  /** Seconds, for every enabled track including announcements (which the rotation never sees). */
  durations: Map<string, number>
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
  const durations = new Map<string, number>()
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
    durations.set(r.id, Math.max(1, r.duration_seconds))
    // Announcements air only by timer.
    if (r.kind === 'promo') continue
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
    durations,
  }
}

export async function autoHitIds(env: Env, now: number): Promise<string[]> {
  const since = new Date(now - AUTO_HIT_DAYS * 86_400_000).toISOString()
  const { results } = await env.DB.prepare(
    'select track_id, count(*) as h from track_likes where created_at >= ? group by track_id having h >= ? order by h desc limit ?',
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
  timerAt?: number
}

function pickAt(p: Planner, at: number): Pick | null {
  return pickNext({
    tracks: p.lib.tracks,
    folders: p.lib.folders,
    slots: p.lib.slots,
    recent: p.recent,
    lastPlayed: p.lastPlayed,
    autoHitIds: p.autoHits,
    now: at,
  })
}

/** Records a play in the planner's memory, so the next pick knows about it. */
function note(p: Planner, trackId: string, at: number, kind: PlayKind): void {
  p.recent.push({ trackId, startsAt: at, kind })
  if (p.recent.length > RECENT_PLAYS) p.recent.shift()
  p.lastPlayed.set(trackId, at)
}

function planOne(p: Planner, at: number): Planned | null {
  const pick = pickAt(p, at)
  if (!pick) return null
  note(p, pick.track.id, at, pick.kind)
  return { trackId: pick.track.id, startsAt: at, endsAt: at + pick.track.duration * 1000, kind: pick.kind, slotTitle: pick.slot?.title ?? '' }
}

function insertPlanned(env: Env, rows: Planned[]): D1PreparedStatement[] {
  return rows.map((r) =>
    env.DB.prepare('insert into program (track_id, starts_at, ends_at, kind, slot_title, timer_at) values (?, ?, ?, ?, ?, ?)').bind(
      r.trackId,
      new Date(r.startsAt).toISOString(),
      new Date(r.endsAt).toISOString(),
      r.kind,
      r.slotTitle,
      r.timerAt === undefined ? null : new Date(r.timerAt).toISOString(),
    ),
  )
}

// ---------- timers: a track at an exact time ----------

interface Occurrence {
  at: number
  trackId: string
  duration: number
}

/** Timer moments in (from, to] that no planned item answers yet, soonest first. */
async function pendingTimers(env: Env, from: number, to: number): Promise<Occurrence[]> {
  const [timers, placed] = await env.DB.batch([
    env.DB.prepare(
      'select tm.track_id, tm.fire_at, tm.minute, t.duration_seconds from track_timers tm join tracks t on t.id = tm.track_id where t.is_enabled = 1',
    ),
    env.DB.prepare('select track_id, timer_at from program where timer_at is not null and timer_at > ?').bind(
      new Date(from - 86_400_000).toISOString(),
    ),
  ])
  const done = new Set((placed.results as { track_id: string; timer_at: string }[]).map((r) => `${r.track_id}|${Date.parse(r.timer_at)}`))
  const offset = STATION_UTC_OFFSET_MIN * 60_000
  const dayStart = Math.floor((from + offset) / 86_400_000) * 86_400_000 - offset
  const out: Occurrence[] = []
  for (const r of timers.results as { track_id: string; fire_at: string | null; minute: number | null; duration_seconds: number }[]) {
    const moments = r.fire_at ? [Date.parse(r.fire_at)] : [0, 1, 2].map((d) => dayStart + d * 86_400_000 + (r.minute ?? 0) * 60_000)
    for (const at of moments) {
      if (at > from && at <= to && !done.has(`${r.track_id}|${at}`)) out.push({ at, trackId: r.track_id, duration: Math.max(1, r.duration_seconds) })
    }
  }
  return out.sort((a, b) => a.at - b.at)
}

/** A planned item that is not a timer: something to put back on the timeline in this order. */
interface Preset {
  trackId: string
  kind: PlayKind
  slotTitle: string
}

/**
 * Keeps the timeline planned about an hour ahead. Cheap when there is nothing
 * to do (one indexed row). Tracks follow each other back to back; if the
 * timeline ran dry (first run, or the VPS was on air for a while) it restarts
 * from now. `preset` items go on first, in order, before the rotation picks.
 *
 * A timer is exact: the track before it is chosen to end as close to the
 * moment as possible and its tail is cut there.
 */
export async function planAhead(env: Env, now: number, force = false, preset: Preset[] = []): Promise<void> {
  const tailRow = await env.DB.prepare('select ends_at from program order by starts_at desc limit 1').first<{ ends_at: string }>()
  const tail = tailRow ? Date.parse(tailRow.ends_at) : 0
  if (!force && tail > now + REPLAN_LEFT_MS) return

  const planner = await loadPlanner(env, now)
  const horizon = now + PLAN_AHEAD_MS
  const timers = await pendingTimers(env, now, horizon)
  const before: D1PreparedStatement[] = []
  let cursor = tail > now ? tail : now
  // A timer inside what is already planned (it was just created): cut the air there.
  if (timers.length > 0 && timers[0].at < cursor) {
    const iso = new Date(timers[0].at).toISOString()
    before.push(env.DB.prepare('delete from program where starts_at >= ?').bind(iso))
    before.push(env.DB.prepare('update program set ends_at = ? where starts_at < ? and ends_at > ?').bind(iso, iso, iso))
    cursor = timers[0].at
  }

  const queue = [...preset]
  const rows: Planned[] = []
  while (rows.length < 90 && (cursor < horizon || queue.length > 0)) {
    const timer = timers[0]
    if (timer && cursor >= timer.at - 500) {
      timers.shift()
      note(planner, timer.trackId, cursor, 'timer')
      rows.push({ trackId: timer.trackId, startsAt: cursor, endsAt: cursor + timer.duration * 1000, kind: 'timer', slotTitle: '', timerAt: timer.at })
      cursor += timer.duration * 1000
      continue
    }
    let next: Planned | null = null
    const fixed = queue.shift()
    if (fixed) {
      const duration = planner.lib.durations.get(fixed.trackId)
      if (!duration) continue // deleted or switched off meanwhile
      note(planner, fixed.trackId, cursor, fixed.kind)
      next = { trackId: fixed.trackId, startsAt: cursor, endsAt: cursor + duration * 1000, kind: fixed.kind, slotTitle: fixed.slotTitle }
    } else {
      const pick = pickAt(planner, cursor)
      if (!pick) break
      let track = pick.track
      let kind = pick.kind
      const room = timer ? (timer.at - cursor) / 1000 : null
      if (timer && room !== null && room < 20) {
        // Too short for anything but a scrap of a track: go straight to the timer.
        cursor = timer.at
        continue
      }
      if (room !== null && kind !== 'jingle' && (track.duration > room + 15 || (track.duration < room && room - track.duration < 45))) {
        // The pick would be cut by the timer, or leave a gap too short for a
        // track: prefer the one that overruns the moment the least, among
        // those that rested at least six hours.
        const fit = poolFor(pick.slot, planner.lib.tracks, planner.lib.folders)
          .filter((t) => t.duration >= room && cursor - (planner.lastPlayed.get(t.id) ?? 0) > 6 * 3600_000)
          .sort((a, b) => a.duration - b.duration)[0]
        if (fit) {
          track = fit
          kind = 'track'
        }
      }
      note(planner, track.id, cursor, kind)
      next = { trackId: track.id, startsAt: cursor, endsAt: cursor + track.duration * 1000, kind, slotTitle: pick.slot?.title ?? '' }
    }
    if (timer && next.endsAt > timer.at) next.endsAt = timer.at
    rows.push(next)
    cursor = next.endsAt
  }
  if (rows.length === 0 && before.length === 0) return
  await env.DB.batch([
    ...before,
    ...insertPlanned(env, rows),
    env.DB.prepare('delete from program where starts_at < ?').bind(new Date(now - KEEP_MS).toISOString()),
    // One-off timers that have had their moment.
    env.DB.prepare('delete from track_timers where fire_at is not null and fire_at < ?').bind(new Date(now - 3600_000).toISOString()),
  ])
}

// ---------- changing what is already planned ----------

export interface UpcomingItem extends Preset {
  id: number
  startsAt: string
}

/** Everything planned after the current track, in order (timers included). */
export async function listUpcoming(env: Env, now: number, limit = 200): Promise<UpcomingItem[]> {
  const { results } = await env.DB.prepare('select id, track_id, starts_at, kind, slot_title from program where starts_at > ? order by starts_at limit ?')
    .bind(new Date(now).toISOString(), limit)
    .all<{ id: number; track_id: string; starts_at: string; kind: string; slot_title: string }>()
  return results.map((r) => ({ id: r.id, trackId: r.track_id, startsAt: r.starts_at, kind: r.kind as PlayKind, slotTitle: r.slot_title }))
}

/**
 * Lays the future out again: what was planned (minus timers, which find their
 * own place), optionally edited, then the rotation. Tracks that were deleted
 * or switched off drop out on the way.
 */
async function rebuild(env: Env, now: number, edit: (list: UpcomingItem[]) => Preset[] = (list) => list): Promise<void> {
  const upcoming = await listUpcoming(env, now)
  const presets = edit(upcoming).filter((p) => p.kind !== 'timer')
  await env.DB.prepare('delete from program where starts_at > ?').bind(new Date(now).toISOString()).run()
  await planAhead(env, now, true, presets)
}

/** Ends the current track now (admin "next track" without the VPS). */
export async function skipCurrent(env: Env, now: number): Promise<void> {
  const iso = new Date(now).toISOString()
  const upcoming = await listUpcoming(env, now)
  await env.DB.batch([
    env.DB.prepare('delete from program where starts_at > ?').bind(iso),
    env.DB.prepare('update program set ends_at = ? where starts_at <= ? and ends_at > ?').bind(iso, iso, iso),
  ])
  await planAhead(env, now, true, upcoming.filter((p) => p.kind !== 'timer'))
}

/** Puts a track at place `position` (1 = right after the current one) in what plays next. */
export async function queueAt(env: Env, now: number, trackId: string, position: number): Promise<void> {
  await rebuild(env, now, (list) => {
    const at = Math.min(Math.max(1, Math.trunc(position) || 1), list.length + 1) - 1
    const next: Preset[] = [...list]
    next.splice(at, 0, { trackId, kind: 'queued', slotTitle: '' })
    return next
  })
}

export async function removeUpcoming(env: Env, now: number, itemId: number): Promise<void> {
  await rebuild(env, now, (list) => list.filter((it) => it.id !== itemId))
}

/** Re-lays the future after the library, the folders or the timers changed. */
export async function replanFuture(env: Env, now: number): Promise<void> {
  await rebuild(env, now)
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
  // Timers can't be exact on the VPS (Liquidsoap finishes its track first):
  // a due one simply goes to the front of what we feed.
  for (const timer of await pendingTimers(env, now - 120_000, now + 180_000)) {
    const row = await env.DB.prepare('select title, artist, file_path from tracks where id = ?').bind(timer.trackId).first<{ title: string; artist: string; file_path: string }>()
    if (!row) continue
    await push(trackUri(env, { title: row.title, artist: row.artist, filePath: row.file_path }))
    await env.DB.batch(insertPlanned(env, [{ trackId: timer.trackId, startsAt: cursor, endsAt: cursor + timer.duration * 1000, kind: 'timer', slotTitle: '', timerAt: timer.at }]))
    cursor += timer.duration * 1000
  }
  for (let i = 0; i < need; i++) {
    const next = planOne(planner, cursor)
    if (!next) return
    const t = byId.get(next.trackId)!
    await push(trackUri(env, { title: t.title, artist: t.artist, filePath: planner.lib.filePaths.get(t.id)! }))
    await env.DB.batch(insertPlanned(env, [next]))
    cursor = next.endsAt
  }
}
