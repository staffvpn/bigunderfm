import { supabase } from './supabase'
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

export function trackPublicUrl(filePath: string): string {
  return supabase.storage.from('tracks').getPublicUrl(filePath).data.publicUrl
}

export function coverPublicUrl(coverPath: string | null): string | null {
  if (!coverPath) return null
  return supabase.storage.from('covers').getPublicUrl(coverPath).data.publicUrl
}

/**
 * Loads the ordered playlist. Defaults to enabled tracks only — listeners must
 * never see or hear a disabled track. Admin screens pass
 * `{ includeDisabled: true }` so a disabled track stays visible (and
 * re-enableable) in the library, and so reorder renumbering covers every row.
 */
export async function fetchPlaylist(
  options: { includeDisabled?: boolean } = {},
): Promise<PlaylistEntry[]> {
  const { data, error } = await supabase
    .from('playlist_items')
    .select(
      'position, tracks!inner(id, title, artist, file_path, cover_path, duration_seconds, file_size_bytes, is_enabled)',
    )
    .order('position', { ascending: true })

  if (error || !data) {
    console.error('fetchPlaylist failed', error)
    return []
  }

  return (data as any[])
    .filter((row) => options.includeDisabled || row.tracks.is_enabled)
    .map((row) => ({
      position: row.position,
      track: {
        id: row.tracks.id,
        title: row.tracks.title,
        artist: row.tracks.artist,
        filePath: row.tracks.file_path,
        coverPath: row.tracks.cover_path,
        durationSeconds: Number(row.tracks.duration_seconds),
        fileSizeBytes: Number(row.tracks.file_size_bytes),
        isEnabled: row.tracks.is_enabled,
      },
    }))
}

export function toPlaylistTracks(entries: PlaylistEntry[]): PlaylistTrack[] {
  return entries.map((e) => ({ trackId: e.track.id, durationSeconds: e.track.durationSeconds }))
}

export interface RadioStateRow {
  anchorAt: string
  isPlaying: boolean
  pausedOffsetSeconds: number | null
  playlistVersion: number
}

export async function fetchRadioState(): Promise<RadioStateRow | null> {
  const { data, error } = await supabase
    .from('radio_state')
    .select('anchor_at, is_playing, paused_offset_seconds, playlist_version')
    .eq('id', true)
    .maybeSingle()

  if (error || !data) {
    console.error('fetchRadioState failed', error)
    return null
  }

  return {
    anchorAt: data.anchor_at,
    isPlaying: data.is_playing,
    pausedOffsetSeconds: data.paused_offset_seconds,
    playlistVersion: data.playlist_version,
  }
}

export async function fetchServerNow(): Promise<Date> {
  const { data, error } = await supabase.rpc('get_server_time')
  if (error || !data) {
    console.error('fetchServerNow failed', error)
    return new Date()
  }
  return new Date(data)
}
