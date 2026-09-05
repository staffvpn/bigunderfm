import { describe, expect, it } from 'vitest'
import { buildTrackFilePath } from './storagePath'

describe('buildTrackFilePath', () => {
  it('keeps a plain ascii extension, drops the rest of the name', () => {
    expect(buildTrackFilePath('track.mp3', 'fixed-id')).toBe('fixed-id.mp3')
  })

  it('strips spaces and cyrillic characters entirely — the reported bug', () => {
    expect(buildTrackFilePath('1 Топовая sensi_snitch_grave_1727152.mp3', 'fixed-id')).toBe('fixed-id.mp3')
  })

  it('lowercases the extension', () => {
    expect(buildTrackFilePath('track.WAV', 'fixed-id')).toBe('fixed-id.wav')
  })

  it('falls back to no extension when the filename has none', () => {
    expect(buildTrackFilePath('track', 'fixed-id')).toBe('fixed-id')
  })

  it('generates a real id when none is supplied', () => {
    const path = buildTrackFilePath('track.mp3')
    expect(path).toMatch(/^[0-9a-f-]{36}\.mp3$/)
  })
})
