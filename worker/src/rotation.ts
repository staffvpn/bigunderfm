// The station's programming brain, as pure functions (no database, no clock)
// so it can be tested. program.ts feeds it the library and what already
// played, and stores what it picks.
//
// How the air is built:
//  - The week is cut into slots (schedule_slots). Each slot points at a
//    folder; the highest-priority slot covering "now" whose folder has
//    tracks is on air. Day parts (Утро/День/Вечер/Ночь) are priority 0,
//    shows sit on top of them for their hour.
//  - Inside a slot tracks come out least-recently-played first, with some
//    randomness, never the same artist close together.
//  - Every few tracks a hit plays (hits repeat every few hours instead of
//    once per rotation), new uploads get extra spins for two weeks, and a
//    jingle goes out every few tracks.

/** Station time: Moscow, UTC+3 all year. Slot times are minutes of this day. */
export const STATION_UTC_OFFSET_MIN = 180

export const JINGLE_EVERY = 5 // tracks between jingles
export const HIT_EVERY = 4 // every 4th track is a hit
export const NEW_EVERY = 5 // every 5th track is a recent upload
export const HIT_GAP_MS = 3 * 3600_000 // the same hit at most once per 3 hours
export const NEW_GAP_MS = 6 * 3600_000
export const NEW_FOR_MS = 14 * 86_400_000 // a track counts as new for two weeks
/** A show does not repeat a track within this time. */
export const SHOW_GAP_MS = 3 * 3600_000
export const ARTIST_GAP = 3 // tracks before the same artist may play again

export interface RTrack {
  id: string
  title: string
  artist: string
  duration: number
  kind: 'track' | 'jingle'
  isHit: boolean
  createdAt: number
  folderIds: string[]
}

export interface RFolder {
  id: string
  name: string
  kind: 'mood' | 'show'
}

export interface RSlot {
  id: string
  folderId: string
  title: string
  /** Weekdays the slot starts on: digits 1 (Monday) .. 7 (Sunday). */
  days: string
  startMinute: number
  endMinute: number
  priority: number
}

/** 'queued' = put on air by an admin ("play next"), outside the rotation. */
export type PlayKind = 'track' | 'hit' | 'new' | 'jingle' | 'queued' | 'timer'

export interface RPlayed {
  trackId: string
  startsAt: number
  kind: PlayKind
}

export interface RotationInput {
  tracks: RTrack[]
  folders: RFolder[]
  slots: RSlot[]
  /** The latest plays, oldest first (a couple of dozen is enough). */
  recent: RPlayed[]
  /** When each track last started, over the whole kept history. */
  lastPlayed: Map<string, number>
  /** Tracks listeners gave the most hearts lately; treated like manual hits. */
  autoHitIds: Set<string>
  now: number
  rng?: () => number
}

export interface Pick {
  track: RTrack
  kind: PlayKind
  slot: RSlot | null
}

const DAY_MIN = 1440

function stationParts(t: number): { weekday: number; minute: number } {
  const d = new Date(t + STATION_UTC_OFFSET_MIN * 60_000)
  return { weekday: d.getUTCDay() === 0 ? 7 : d.getUTCDay(), minute: d.getUTCHours() * 60 + d.getUTCMinutes() }
}

function prevDay(weekday: number): number {
  return weekday === 1 ? 7 : weekday - 1
}

export function slotCovers(slot: RSlot, t: number): boolean {
  const { weekday, minute } = stationParts(t)
  const today = slot.days.includes(String(weekday))
  if (slot.startMinute === slot.endMinute) return today
  if (slot.startMinute < slot.endMinute) return today && minute >= slot.startMinute && minute < slot.endMinute
  // Wraps past midnight (e.g. 23:00-06:00): the tail belongs to yesterday's start.
  return (today && minute >= slot.startMinute) || (slot.days.includes(String(prevDay(weekday))) && minute < slot.endMinute)
}

function slotLength(slot: RSlot): number {
  const len = slot.endMinute - slot.startMinute
  return len > 0 ? len : len + DAY_MIN
}

/** The slot on air at `t`: highest priority first, the shorter one on a tie. */
export function activeSlot(slots: RSlot[], t: number, usable: (slot: RSlot) => boolean = () => true): RSlot | null {
  let best: RSlot | null = null
  for (const s of slots) {
    if (!slotCovers(s, t) || !usable(s)) continue
    if (!best || s.priority > best.priority || (s.priority === best.priority && slotLength(s) < slotLength(best))) best = s
  }
  return best
}

/** When the slot on air changes next (looking up to two days ahead), and to what. */
export function nextSlotChange(
  slots: RSlot[],
  t: number,
  usable: (slot: RSlot) => boolean = () => true,
): { at: number; slot: RSlot | null } | null {
  const current = activeSlot(slots, t, usable)
  const { minute } = stationParts(t)
  const dayStart = Math.floor(t / 60_000) * 60_000 - minute * 60_000
  const edges = new Set<number>()
  for (let day = 0; day <= 2; day++) {
    for (const s of slots) {
      edges.add(dayStart + (day * DAY_MIN + s.startMinute) * 60_000)
      edges.add(dayStart + (day * DAY_MIN + s.endMinute) * 60_000)
    }
  }
  for (const at of [...edges].filter((e) => e > t).sort((a, b) => a - b)) {
    const slot = activeSlot(slots, at, usable)
    if ((slot?.id ?? null) !== (current?.id ?? null)) return { at, slot }
  }
  return null
}

/** First credited name, lowercased: "Busta Rhymes, J Dilla" and "busta rhymes" are one artist. */
export function artistKey(artist: string): string {
  return artist
    .toLowerCase()
    .split(/,|\/|&|\+| x | feat\.? | ft\.? /)[0]
    .trim()
}

function jingleKey(t: RTrack): string {
  return t.title.trim().toLowerCase()
}

/** Tracks a slot may play. No slot (nothing scheduled) means the whole library. */
export function poolFor(slot: RSlot | null, tracks: RTrack[], folders: RFolder[]): RTrack[] {
  const music = tracks.filter((t) => t.kind === 'track')
  if (!slot) return music
  const folder = folders.find((f) => f.id === slot.folderId)
  if (!folder) return music
  if (folder.kind === 'show') return music.filter((t) => t.folderIds.includes(folder.id))
  // A track nobody filed anywhere yet plays in every day part, so a fresh
  // upload is on air before anyone sorts it.
  return music.filter((t) => t.folderIds.includes(folder.id) || t.folderIds.length === 0)
}

export function slotUsable(tracks: RTrack[], folders: RFolder[]): (slot: RSlot) => boolean {
  return (slot) => poolFor(slot, tracks, folders).length > 0 && folders.some((f) => f.id === slot.folderId)
}

function choose(cands: RTrack[], input: RotationInput, recentArtists: string[], roomSeconds: number | null): RTrack | null {
  if (cands.length === 0) return null
  const rng = input.rng ?? Math.random
  const last = (t: RTrack) => input.lastPlayed.get(t.id) ?? 0
  // Least recently played first; a random pick among the oldest third keeps
  // the order from repeating day after day.
  const sorted = [...cands].sort((a, b) => last(a) - last(b))
  const neverPlayed = sorted.filter((t) => last(t) === 0)
  let head = neverPlayed.length > 0 ? neverPlayed : sorted.slice(0, Math.max(5, Math.ceil(sorted.length / 3)))
  const otherArtist = head.filter((t) => !recentArtists.includes(artistKey(t.artist)))
  if (otherArtist.length > 0) head = otherArtist
  // A half-hour tape shouldn't start five minutes before the slot ends.
  if (roomSeconds !== null) {
    const fits = head.filter((t) => t.duration <= Math.max(roomSeconds + 300, 600))
    if (fits.length > 0) head = fits
  }
  return head[Math.floor(rng() * head.length)] ?? head[0]
}

export function pickNext(input: RotationInput): Pick | null {
  const { tracks, folders, slots, recent, now } = input
  if (tracks.length === 0) return null
  const usable = slotUsable(tracks, folders)
  // A show plays each of its tracks once per airing: when all of them have
  // been heard in the last hours, the air goes back to the day part under it.
  const showFolder = (sl: RSlot) => folders.find((f) => f.id === sl.folderId)?.kind === 'show'
  const showFresh = (sl: RSlot) => poolFor(sl, tracks, folders).filter((t) => now - (input.lastPlayed.get(t.id) ?? 0) >= SHOW_GAP_MS)
  const usableNow = (sl: RSlot) => usable(sl) && (!showFolder(sl) || showFresh(sl).length > 0)
  const slot = activeSlot(slots, now, usableNow)
  const change = nextSlotChange(slots, now, usable)
  const roomSeconds = change ? (change.at - now) / 1000 : null

  // Jingle: after every JINGLE_EVERY tracks, the least recently heard one.
  const jingles = tracks.filter((t) => t.kind === 'jingle')
  let sinceJingle = 0
  for (let i = recent.length - 1; i >= 0 && recent[i].kind !== 'jingle'; i--) sinceJingle++
  if (jingles.length > 0 && recent.length > 0 && sinceJingle >= JINGLE_EVERY) {
    const lastByKey = new Map<string, number>()
    for (const j of jingles) lastByKey.set(jingleKey(j), Math.max(lastByKey.get(jingleKey(j)) ?? 0, input.lastPlayed.get(j.id) ?? 0))
    const oldest = Math.min(...lastByKey.values())
    const group = jingles.filter((j) => lastByKey.get(jingleKey(j)) === oldest)
    const rng = input.rng ?? Math.random
    return { track: group[Math.floor(rng() * group.length)] ?? group[0], kind: 'jingle', slot }
  }

  let pool = slot && showFolder(slot) ? showFresh(slot) : poolFor(slot, tracks, folders)
  if (pool.length === 0) pool = tracks.filter((t) => t.kind === 'track')
  if (pool.length === 0) return { track: jingles[0], kind: 'jingle', slot }

  const music = recent.filter((r) => r.kind !== 'jingle')
  const byId = new Map(tracks.map((t) => [t.id, t]))
  const recentArtists = music
    .slice(-ARTIST_GAP)
    .map((r) => byId.get(r.trackId))
    .filter((t): t is RTrack => !!t)
    .map((t) => artistKey(t.artist))
  const since = (kind: PlayKind) => {
    let n = 0
    for (let i = music.length - 1; i >= 0 && music[i].kind !== kind; i--) n++
    return n
  }
  const rested = (t: RTrack, gap: number) => now - (input.lastPlayed.get(t.id) ?? 0) >= gap
  const isHit = (t: RTrack) => t.isHit || input.autoHitIds.has(t.id)
  const isShow = slot ? folders.find((f) => f.id === slot.folderId)?.kind === 'show' : false

  if (since('hit') >= HIT_EVERY - 1) {
    let hits = pool.filter((t) => isHit(t) && rested(t, HIT_GAP_MS))
    // A day part with no hits of its own borrows from the rest of the
    // library (never from show-only tracks, and never inside a show).
    if (hits.length === 0 && !isShow) {
      const showIds = new Set(folders.filter((f) => f.kind === 'show').map((f) => f.id))
      hits = tracks.filter(
        (t) =>
          t.kind === 'track' &&
          isHit(t) &&
          rested(t, HIT_GAP_MS) &&
          !(t.folderIds.length > 0 && t.folderIds.every((id) => showIds.has(id))),
      )
    }
    const hit = choose(hits, input, recentArtists, roomSeconds)
    if (hit) return { track: hit, kind: 'hit', slot }
  }

  if (since('new') >= NEW_EVERY - 1) {
    const fresh = pool.filter((t) => now - t.createdAt < NEW_FOR_MS && rested(t, NEW_GAP_MS))
    const pick = choose(fresh, input, recentArtists, roomSeconds)
    if (pick) return { track: pick, kind: 'new', slot }
  }

  const track = choose(pool, input, recentArtists, roomSeconds)
  return track ? { track, kind: 'track', slot } : null
}
