import { api } from './api'
import type { PlaylistTrack } from './radioClock'

export interface Track {
  id: string
  title: string
  artist: string
  filePath: string
  coverPath: string | null
  durationSeconds: number
  fileSizeBytes: number
  isEnabled: boolean
}

export interface PlaylistEntry {
  position: number
  track: Track
}

/**
 * Loads the ordered playlist. Defaults to enabled tracks only, so listeners
 * never see a disabled track. Admin screens pass `{ includeDisabled: true }`
 * so a disabled track stays visible (and re-enableable) in the library.
 */
export async function fetchPlaylist(options: { includeDisabled?: boolean } = {}): Promise<PlaylistEntry[]> {
  try {
    const path = options.includeDisabled ? '/api/admin/library' : '/api/playlist'
    const data = await api<{ entries: PlaylistEntry[] }>(path)
    return data.entries
  } catch (err) {
    console.error('fetchPlaylist failed', err)
    return []
  }
}

export function toPlaylistTracks(entries: PlaylistEntry[]): PlaylistTrack[] {
  return entries.map((e) => ({ trackId: e.track.id, durationSeconds: e.track.durationSeconds }))
}
