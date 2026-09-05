import { describe, expect, it, vi } from 'vitest'

vi.mock('music-metadata-browser', () => ({
  parseBlob: vi.fn(),
}))

import { parseBlob } from 'music-metadata-browser'
import { extractTrackMetadata } from './metadata'

function makeFile(name: string): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'audio/mpeg' })
}

describe('extractTrackMetadata', () => {
  it('uses tag data when present', async () => {
    vi.mocked(parseBlob).mockResolvedValueOnce({
      common: { title: 'Night Drive', artist: 'DJ Concrete', picture: undefined },
      format: { duration: 214.5 },
    } as any)

    const result = await extractTrackMetadata(makeFile('01-track.mp3'))

    expect(result).toEqual({
      title: 'Night Drive',
      artist: 'DJ Concrete',
      durationSeconds: 214.5,
      coverBlob: null,
    })
  })

  it('falls back to filename and defaults when tags are missing', async () => {
    vi.mocked(parseBlob).mockResolvedValueOnce({
      common: {},
      format: {},
    } as any)

    const result = await extractTrackMetadata(makeFile('warehouse session.mp3'))

    expect(result.title).toBe('warehouse session')
    expect(result.artist).toBe('Unknown Artist')
    expect(result.durationSeconds).toBe(0)
    expect(result.coverBlob).toBeNull()
  })

  it('falls back gracefully when parsing throws', async () => {
    vi.mocked(parseBlob).mockRejectedValueOnce(new Error('corrupt file'))

    const result = await extractTrackMetadata(makeFile('broken.mp3'))

    expect(result.title).toBe('broken')
    expect(result.artist).toBe('Unknown Artist')
  })

  it('extracts an embedded cover picture as a Blob', async () => {
    vi.mocked(parseBlob).mockResolvedValueOnce({
      common: {
        title: 'Cover Test',
        artist: 'Artist',
        picture: [{ data: new Uint8Array([9, 9, 9]), format: 'image/jpeg' }],
      },
      format: { duration: 100 },
    } as any)

    const result = await extractTrackMetadata(makeFile('cover.mp3'))

    expect(result.coverBlob).toBeInstanceOf(Blob)
    expect(result.coverBlob?.type).toBe('image/jpeg')
  })
})
