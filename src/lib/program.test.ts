import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { afterItem, isLeftBehind, tuneIn, type Program, type ProgramItem } from './program'

const T0 = Date.parse('2026-11-11T18:00:00Z')

function item(id: number, startSec: number, durSec: number): ProgramItem {
  return {
    id,
    startsAt: new Date(T0 + startSec * 1000).toISOString(),
    endsAt: new Date(T0 + (startSec + durSec) * 1000).toISOString(),
    kind: 'track',
    isNew: false,
    track: { id: `t${id}`, title: `t${id}`, artist: 'a', filePath: `${id}.mp3`, durationSeconds: durSec },
  }
}

const program = (items: ProgramItem[], clockOffsetMs = 0): Program => ({
  now: new Date(T0).toISOString(),
  vpsUp: false,
  slot: null,
  nextSlot: null,
  items,
  clockOffsetMs,
})

describe('program timeline', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('joins the current track at the right offset', () => {
    vi.setSystemTime(T0 + 70_000)
    const t = tuneIn(program([item(1, 0, 180), item(2, 180, 200)]))
    expect(t?.item.id).toBe(1)
    expect(t?.offsetSeconds).toBeCloseTo(70)
  })

  it('corrects for a phone clock that is wrong', () => {
    vi.setSystemTime(T0 - 3600_000 + 70_000) // phone is an hour slow
    const t = tuneIn(program([item(1, 0, 180)], 3600_000))
    expect(t?.item.id).toBe(1)
    expect(t?.offsetSeconds).toBeCloseTo(70)
  })

  it('starts the next track from the top when only slightly behind', () => {
    vi.setSystemTime(T0 + 188_000)
    const t = afterItem(program([item(1, 0, 180), item(2, 180, 200)]), 1)
    expect(t).toMatchObject({ offsetSeconds: 0 })
    expect(t?.item.id).toBe(2)
  })

  it('jumps to where the air is when far behind', () => {
    vi.setSystemTime(T0 + 440_000)
    const t = afterItem(program([item(1, 0, 180), item(2, 180, 200), item(3, 380, 200)]), 1)
    expect(t?.item.id).toBe(3)
    expect(t?.offsetSeconds).toBeCloseTo(60)
  })

  it('does not replay a track that ended a little early', () => {
    vi.setSystemTime(T0 + 175_000)
    const t = afterItem(program([item(1, 0, 180), item(2, 180, 200)]), 1)
    expect(t?.item.id).toBe(2)
  })

  it('notices a skipped track only after a while', () => {
    const p = program([item(5, 100, 200)])
    vi.setSystemTime(T0 + 110_000)
    expect(isLeftBehind(p, 4)).toBe(false)
    vi.setSystemTime(T0 + 140_000)
    expect(isLeftBehind(p, 4)).toBe(true)
    expect(isLeftBehind(p, 5)).toBe(false)
  })
})
