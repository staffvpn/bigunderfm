import { describe, expect, it } from 'vitest'
import { activeSlot, artistKey, nextSlotChange, pickNext, poolFor, slotCovers, type RFolder, type RPlayed, type RSlot, type RTrack } from './rotation'

// Station time is UTC+3: 2026-11-09 is a Monday.
const msk = (iso: string) => Date.parse(`${iso}+03:00`)

const folders: RFolder[] = [
  { id: 'morning', name: 'Утро', kind: 'mood' },
  { id: 'evening', name: 'Вечер', kind: 'mood' },
  { id: 'night', name: 'Ночь', kind: 'mood' },
  { id: 'show', name: 'NO SLEEP CLUB', kind: 'show' },
]
const slots: RSlot[] = [
  { id: 'm', folderId: 'morning', title: 'УТРО', days: '1234567', startMinute: 360, endMinute: 1020, priority: 0 },
  { id: 'e', folderId: 'evening', title: 'ВЕЧЕР', days: '1234567', startMinute: 1020, endMinute: 1380, priority: 0 },
  { id: 'n', folderId: 'night', title: 'НОЧЬ', days: '1234567', startMinute: 1380, endMinute: 360, priority: 0 },
  { id: 's', folderId: 'show', title: 'NO SLEEP CLUB', days: '5', startMinute: 1140, endMinute: 1200, priority: 10 },
]

function track(id: string, folderIds: string[], extra: Partial<RTrack> = {}): RTrack {
  return { id, title: id, artist: `artist-${id}`, duration: 180, kind: 'track', isHit: false, createdAt: 0, folderIds, ...extra }
}

function library(): RTrack[] {
  const out: RTrack[] = []
  for (let i = 0; i < 20; i++) out.push(track(`m${i}`, ['morning']))
  for (let i = 0; i < 20; i++) out.push(track(`e${i}`, ['evening']))
  for (let i = 0; i < 20; i++) out.push(track(`n${i}`, ['night']))
  return out
}

/** Runs the rotation for `count` picks starting at `start`, like the planner does. */
function run(tracks: RTrack[], start: number, count: number, autoHits: string[] = []) {
  const recent: RPlayed[] = []
  const lastPlayed = new Map<string, number>()
  const out: { id: string; kind: string; slot: string | null; at: number }[] = []
  let now = start
  let seed = 7
  const rng = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
  for (let i = 0; i < count; i++) {
    const pick = pickNext({ tracks, folders, slots, recent, lastPlayed, autoHitIds: new Set(autoHits), now, rng })
    if (!pick) break
    out.push({ id: pick.track.id, kind: pick.kind, slot: pick.slot?.id ?? null, at: now })
    recent.push({ trackId: pick.track.id, startsAt: now, kind: pick.kind })
    lastPlayed.set(pick.track.id, now)
    now += pick.track.duration * 1000
  }
  return out
}

describe('slots', () => {
  it('covers a slot that runs past midnight', () => {
    const night = slots[2]
    expect(slotCovers(night, msk('2026-11-09T23:30:00'))).toBe(true)
    expect(slotCovers(night, msk('2026-11-10T03:00:00'))).toBe(true)
    expect(slotCovers(night, msk('2026-11-10T06:00:00'))).toBe(false)
  })

  it('puts a show on top of the day part only on its weekday', () => {
    expect(activeSlot(slots, msk('2026-11-13T19:30:00'))?.id).toBe('s') // Friday
    expect(activeSlot(slots, msk('2026-11-12T19:30:00'))?.id).toBe('e') // Thursday
  })

  it('skips a show whose folder is empty', () => {
    const usable = (s: RSlot) => s.id !== 's'
    expect(activeSlot(slots, msk('2026-11-13T19:30:00'), usable)?.id).toBe('e')
  })

  it('finds the next change of slot', () => {
    const change = nextSlotChange(slots, msk('2026-11-13T18:00:00'))
    expect(change?.slot?.id).toBe('s')
    expect(change?.at).toBe(msk('2026-11-13T19:00:00'))
    const after = nextSlotChange(slots, msk('2026-11-13T19:10:00'))
    expect(after?.slot?.id).toBe('e')
    expect(after?.at).toBe(msk('2026-11-13T20:00:00'))
  })
})

describe('pools', () => {
  it('plays unfiled tracks in every day part but not in shows', () => {
    const tracks = [track('a', ['morning']), track('b', []), track('c', ['show'])]
    expect(poolFor(slots[0], tracks, folders).map((t) => t.id)).toEqual(['a', 'b'])
    expect(poolFor(slots[3], tracks, folders).map((t) => t.id)).toEqual(['c'])
  })

  it('treats the first credited name as the artist', () => {
    expect(artistKey('Busta Rhymes, J Dilla, Lil Wayne')).toBe('busta rhymes')
    expect(artistKey('Cordae/Anderson .Paak')).toBe('cordae')
    expect(artistKey('wun two & biggie smalls')).toBe('wun two')
  })
})

describe('rotation', () => {
  it('keeps to the folder of the day part on air', () => {
    const plays = run(library(), msk('2026-11-09T18:00:00'), 15)
    expect(plays.every((p) => p.id.startsWith('e'))).toBe(true)
  })

  it('plays the whole folder before repeating a track', () => {
    const plays = run(library(), msk('2026-11-09T18:00:00'), 20)
    expect(new Set(plays.map((p) => p.id)).size).toBe(20)
  })

  it('switches folders when the day part changes', () => {
    const plays = run(library(), msk('2026-11-09T22:50:00'), 8)
    expect(plays[0].id.startsWith('e')).toBe(true)
    expect(plays[plays.length - 1].id.startsWith('n')).toBe(true)
  })

  it('brings a hit back every fourth track, but not the same one within three hours', () => {
    const tracks = library()
    tracks[20].isHit = true // e0
    tracks[21].isHit = true // e1
    const plays = run(tracks, msk('2026-11-09T17:00:00'), 40)
    const hits = plays.filter((p) => p.kind === 'hit')
    expect(hits.length).toBeGreaterThanOrEqual(2)
    for (const id of ['e0', 'e1']) {
      const times = hits.filter((p) => p.id === id).map((p) => p.at)
      for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(3 * 3600_000)
    }
  })

  // 100 unfiled tracks (on air in every day part): nothing repeats within
  // five hours unless the rotation brings it back on purpose.
  const big = () => Array.from({ length: 150 }, (_, i) => track(`u${i}`, []))

  it('treats listener favourites as hits', () => {
    const plays = run(big(), msk('2026-11-09T12:00:00'), 90, ['u5'])
    expect(plays.filter((p) => p.id === 'u5').length).toBeGreaterThanOrEqual(2)
    expect(plays.filter((p) => p.id === 'u6').length).toBeLessThanOrEqual(1)
  })

  it('gives new uploads extra spins', () => {
    const start = msk('2026-11-09T08:00:00')
    const tracks = [...big(), track('fresh', [], { createdAt: start - 86_400_000 })]
    const plays = run(tracks, start, 130)
    expect(plays.filter((p) => p.id === 'fresh').length).toBeGreaterThanOrEqual(2)
    expect(plays.some((p) => p.kind === 'new' && p.id === 'fresh')).toBe(true)
  })

  it('plays a jingle after every five tracks and never two in a row', () => {
    const tracks = [...library(), track('j1', [], { kind: 'jingle', title: 'JINGLE 3' }), track('j2', [], { kind: 'jingle', title: 'JINGLE 4' })]
    const plays = run(tracks, msk('2026-11-09T18:00:00'), 24)
    const kinds = plays.map((p) => (p.kind === 'jingle' ? 'j' : 't')).join('')
    expect(kinds.startsWith('tttttjtttttj')).toBe(true)
    expect(kinds.includes('jj')).toBe(false)
    const jingles = plays.filter((p) => p.kind === 'jingle').map((p) => p.id)
    expect(jingles[0]).not.toBe(jingles[1])
  })

  it('does not put the same artist close together', () => {
    const tracks = library().map((t, i) => (t.id.startsWith('e') ? { ...t, artist: i % 2 ? 'DMX' : `solo-${i}` } : t))
    const plays = run(tracks, msk('2026-11-09T18:00:00'), 12)
    const byId = new Map(tracks.map((t) => [t.id, t.artist]))
    for (let i = 1; i < plays.length; i++) {
      if (byId.get(plays[i].id) === 'DMX') expect(byId.get(plays[i - 1].id)).not.toBe('DMX')
    }
  })

  it('falls back to the whole library when nothing is scheduled', () => {
    const plays = run(library(), msk('2026-11-09T18:00:00'), 3)
    expect(plays.length).toBe(3)
    const none = pickNext({ tracks: library(), folders, slots: [], recent: [], lastPlayed: new Map(), autoHitIds: new Set(), now: 0 })
    expect(none?.slot).toBeNull()
  })
})
