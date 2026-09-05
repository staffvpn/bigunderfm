export interface PlaylistTrack {
  trackId: string
  durationSeconds: number
}

export interface RadioState {
  anchorAt: string
  isPlaying: boolean
  pausedOffsetSeconds: number | null
}

export interface RadioPosition {
  trackIndex: number
  trackId: string
  offsetSeconds: number
}

export function totalDuration(playlist: PlaylistTrack[]): number {
  return playlist.reduce((sum, t) => sum + t.durationSeconds, 0)
}

export function computeCurrentPosition(
  playlist: PlaylistTrack[],
  radioState: RadioState,
  serverNow: Date,
): RadioPosition | null {
  if (playlist.length === 0) return null

  if (!radioState.isPlaying) {
    return positionAtElapsed(playlist, radioState.pausedOffsetSeconds ?? 0)
  }

  const total = totalDuration(playlist)
  if (total <= 0) return null

  const anchorMs = new Date(radioState.anchorAt).getTime()
  const rawElapsedSeconds = (serverNow.getTime() - anchorMs) / 1000
  const elapsed = ((rawElapsedSeconds % total) + total) % total

  return positionAtElapsed(playlist, elapsed)
}

function positionAtElapsed(playlist: PlaylistTrack[], elapsed: number): RadioPosition {
  let cumulative = 0
  for (let i = 0; i < playlist.length; i++) {
    const track = playlist[i]
    if (elapsed < cumulative + track.durationSeconds) {
      return { trackIndex: i, trackId: track.trackId, offsetSeconds: elapsed - cumulative }
    }
    cumulative += track.durationSeconds
  }
  const last = playlist[playlist.length - 1]
  return { trackIndex: playlist.length - 1, trackId: last.trackId, offsetSeconds: last.durationSeconds }
}

export function secondsUntilNextBoundary(playlist: PlaylistTrack[], position: RadioPosition): number {
  return playlist[position.trackIndex].durationSeconds - position.offsetSeconds
}
