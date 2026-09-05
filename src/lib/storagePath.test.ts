import { describe, expect, it } from 'vitest'
import { audioContentType, buildTrackFilePath } from './storagePath'

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

describe('audioContentType', () => {
  it('normalizes .wav to the bucket-allowed type regardless of what the browser reports', () => {
    expect(audioContentType('D_05.wav', 'audio/x-wav')).toBe('audio/wav')
    expect(audioContentType('D_05.wav', 'audio/wave')).toBe('audio/wav')
    expect(audioContentType('D_05.wav', '')).toBe('audio/wav')
  })

  it('normalizes .mp3 to audio/mpeg', () => {
    expect(audioContentType('track.mp3', '')).toBe('audio/mpeg')
  })

  it('normalizes .m4a/.mp4 to audio/mp4', () => {
    expect(audioContentType('track.m4a', '')).toBe('audio/mp4')
    expect(audioContentType('track.mp4', '')).toBe('audio/mp4')
  })

  it('falls back to the browser-supplied type for an unrecognized extension', () => {
    expect(audioContentType('track.ogg', 'audio/ogg')).toBe('audio/ogg')
  })
})
