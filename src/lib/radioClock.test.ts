import { describe, expect, it } from 'vitest'
import { computeCurrentPosition, secondsUntilNextBoundary, totalDuration } from './radioClock'

const playlist = [
  { trackId: 'a', durationSeconds: 100 },
  { trackId: 'b', durationSeconds: 200 },
  { trackId: 'c', durationSeconds: 150 },
]

describe('totalDuration', () => {
  it('sums track durations', () => {
    expect(totalDuration(playlist)).toBe(450)
  })
})

describe('computeCurrentPosition', () => {
  it('returns the first track at elapsed 0', () => {
    const now = new Date('2026-01-01T00:00:00Z')
    const state = { anchorAt: now.toISOString(), isPlaying: true, pausedOffsetSeconds: null }
    const pos = computeCurrentPosition(playlist, state, now)
    expect(pos).toEqual({ trackIndex: 0, trackId: 'a', offsetSeconds: 0 })
  })

  it('returns the correct offset inside the second track', () => {
    const anchor = new Date('2026-01-01T00:00:00Z')
    const now = new Date(anchor.getTime() + 150_000) // 150s elapsed: 100s into track a done, 50s into b
    const state = { anchorAt: anchor.toISOString(), isPlaying: true, pausedOffsetSeconds: null }
    const pos = computeCurrentPosition(playlist, state, now)
    expect(pos).toEqual({ trackIndex: 1, trackId: 'b', offsetSeconds: 50 })
  })

  it('loops back to the first track after the total duration', () => {
    const anchor = new Date('2026-01-01T00:00:00Z')
    const now = new Date(anchor.getTime() + 460_000) // 450s total + 10s into the next loop
    const state = { anchorAt: anchor.toISOString(), isPlaying: true, pausedOffsetSeconds: null }
    const pos = computeCurrentPosition(playlist, state, now)
    expect(pos).toEqual({ trackIndex: 0, trackId: 'a', offsetSeconds: 10 })
  })

  it('uses pausedOffsetSeconds when not playing', () => {
    const state = { anchorAt: new Date().toISOString(), isPlaying: false, pausedOffsetSeconds: 120 }
    const pos = computeCurrentPosition(playlist, state, new Date())
    expect(pos).toEqual({ trackIndex: 1, trackId: 'b', offsetSeconds: 20 })
  })

  it('returns null for an empty playlist', () => {
    const state = { anchorAt: new Date().toISOString(), isPlaying: true, pausedOffsetSeconds: null }
    expect(computeCurrentPosition([], state, new Date())).toBeNull()
  })
})

describe('secondsUntilNextBoundary', () => {
  it('returns the remaining seconds in the current track', () => {
    const pos = { trackIndex: 1, trackId: 'b', offsetSeconds: 50 }
    expect(secondsUntilNextBoundary(playlist, pos)).toBe(150)
  })
})
