import { api } from './api'
import { applyAccent } from './accent'

// The station's planned air (see worker/src/program.ts): the current and next
// few tracks with their exact times, plus which part of the grid is on. While
// the radio server is down the app plays exactly this timeline from R2, so
// every listener hears the same track at the same moment.

export interface ProgramTrack {
  id: string
  title: string
  artist: string
  filePath: string
  durationSeconds: number
}

export interface ProgramItem {
  id: number
  startsAt: string
  endsAt: string
  kind: 'track' | 'hit' | 'new' | 'jingle' | 'queued' | 'timer'
  isNew: boolean
  track: ProgramTrack
}

export interface ProgramView {
  now: string
  vpsUp: boolean
  tunnel?: string | null
  slot: { title: string; label?: string; endsAt: string | null } | null
  nextSlot: { title: string; startsAt: string; show?: boolean } | null
  accent?: string | null
  /** Everyone who has ever opened the app in Telegram. */
  listenersTotal?: number | null
  items: ProgramItem[]
}

export interface Program extends ProgramView {
  /** Server clock minus this phone's clock, in ms (phones are often off by a lot). */
  clockOffsetMs: number
}

export async function fetchProgram(): Promise<Program | null> {
  try {
    const sent = Date.now()
    const view = await api<ProgramView>('/api/program')
    if (!Array.isArray(view?.items)) return null
    if (view.accent !== undefined) applyAccent(view.accent)
    const received = Date.now()
    return { ...view, clockOffsetMs: Date.parse(view.now) - (sent + received) / 2 }
  } catch {
    return null
  }
}

export function stationNow(program: Program): number {
  return Date.now() + program.clockOffsetMs
}

export interface TuneIn {
  item: ProgramItem
  offsetSeconds: number
}

/** Where to join the air right now: the item on at this moment and how far in. */
export function tuneIn(program: Program): TuneIn | null {
  const now = stationNow(program)
  const current = program.items.find((it) => Date.parse(it.startsAt) <= now && now < Date.parse(it.endsAt))
  if (current) return { item: current, offsetSeconds: (now - Date.parse(current.startsAt)) / 1000 }
  const upcoming = program.items.find((it) => Date.parse(it.startsAt) > now)
  return upcoming ? { item: upcoming, offsetSeconds: 0 } : null
}

// Everyone hears roughly the same moment. The next track is loaded ahead of
// time, so a phone is rarely behind at all; when it is a few seconds behind,
// the next track still starts from its very first second (cutting the intro
// sounds broken). Only a phone clearly behind skips ahead, and one far behind
// (asleep in the background) joins wherever the air is now.
const MAX_LAG_SECONDS = 20
/** Behind by less than this, the next track starts from the top. */
export const SKIP_IF_BEHIND_SECONDS = 8

/** What to play once item `finishedId` ended on this phone. */
export function afterItem(program: Program, finishedId: number | null): TuneIn | null {
  const now = stationNow(program)
  const i = program.items.findIndex((it) => it.id === finishedId)
  const next = i >= 0 ? program.items[i + 1] : undefined
  if (next) {
    const lag = (now - Date.parse(next.startsAt)) / 1000
    if (lag <= MAX_LAG_SECONDS && now < Date.parse(next.endsAt)) return { item: next, offsetSeconds: lag > SKIP_IF_BEHIND_SECONDS ? lag : 0 }
  }
  const live = tuneIn(program)
  if (!live) return null
  // Never restart the track that just finished because the clock says it has a few seconds left.
  if (live.item.id === finishedId) {
    const following = program.items[program.items.indexOf(live.item) + 1]
    return following ? { item: following, offsetSeconds: 0 } : null
  }
  return live
}

/**
 * True when the track this phone plays was cut on air (an admin skipped it,
 * or it was deleted): the phone should leave it now. A phone that is merely
 * a little behind is not "left behind": it finishes the track and goes on.
 */
export function isLeftBehind(program: Program, playingId: number | null): boolean {
  if (playingId === null) return false
  const playing = program.items.find((it) => it.id === playingId)
  if (playing) {
    const planned = (Date.parse(playing.endsAt) - Date.parse(playing.startsAt)) / 1000
    const cut = planned < (playing.track.durationSeconds || Infinity) - 3
    return cut && stationNow(program) - Date.parse(playing.endsAt) > 3000
  }
  const live = tuneIn(program)
  if (!live) return false
  return (stationNow(program) - Date.parse(live.item.startsAt)) / 1000 > MAX_LAG_SECONDS + 10
}

const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })

/** "ВЕЧЕР до 23:00" / "далее НОЧЬ" for the line under the station name. */
export function gridLine(program: Program | null): { now: string; next: string | null } | null {
  if (!program?.slot) return null
  return {
    now: program.slot.endsAt ? `${program.slot.title} до ${hhmm(program.slot.endsAt)}` : program.slot.title,
    next: program.nextSlot ? `далее ${program.nextSlot.title}` : null,
  }
}
