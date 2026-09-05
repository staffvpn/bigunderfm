import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { computeCurrentPosition, secondsUntilNextBoundary, type RadioPosition } from '../lib/radioClock'
import {
  fetchPlaylist,
  fetchRadioState,
  fetchServerNow,
  toPlaylistTracks,
  trackPublicUrl,
  coverPublicUrl,
  type PlaylistEntry,
} from '../lib/tracks'
import { OnAirBadge } from '../components/OnAirBadge'
import { ProgressBar } from '../components/ProgressBar'
import { CoverArt } from '../components/CoverArt'

export function RadioScreen() {
  const [entries, setEntries] = useState<PlaylistEntry[]>([])
  const [position, setPosition] = useState<RadioPosition | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [listenerCount, setListenerCount] = useState(1)
  const [userStarted, setUserStarted] = useState(false)
  const [isPaused, setIsPaused] = useState(true)
  const audioRef = useRef<HTMLAudioElement>(null)
  const advanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const entriesRef = useRef<PlaylistEntry[]>([])

  // hasInteractedRef/isPausedRef (not the userStarted/isPaused state below) are
  // what applyPositionToAudio actually reads. The mount-only effect captures
  // resync/applyPositionToAudio/scheduleNextAdvance exactly once, so any
  // *state* they read stays frozen at its value from that first render
  // forever — reading `userStarted` state here would always see `false`,
  // silently auto-pausing playback on every later resync. Refs don't have
  // this problem: the closures still hold a stable reference to the same
  // ref object, and `.current` always reflects the latest value. The
  // `userStarted`/`isPaused` state below exists purely so the button can
  // re-render — calling their setters from inside the frozen closures is
  // fine; it's only *reading* state there that would be stale.
  const hasInteractedRef = useRef(false)
  const isPausedRef = useRef(true)

  useEffect(() => {
    entriesRef.current = entries
  }, [entries])

  async function resync() {
    const [playlist, radioState, serverNow] = await Promise.all([
      fetchPlaylist(),
      fetchRadioState(),
      fetchServerNow(),
    ])

    setEntries(playlist)
    setIsPlaying(radioState?.isPlaying ?? false)
    if (!radioState) return

    const tracks = toPlaylistTracks(playlist)
    const pos = computeCurrentPosition(
      tracks,
      {
        anchorAt: radioState.anchorAt,
        isPlaying: radioState.isPlaying,
        pausedOffsetSeconds: radioState.pausedOffsetSeconds,
      },
      serverNow,
    )

    setPosition(pos)
    applyPositionToAudio(pos, radioState.isPlaying, playlist)
    scheduleNextAdvance(tracks, pos, radioState.isPlaying)
  }

  function applyPositionToAudio(pos: RadioPosition | null, playing: boolean, playlist: PlaylistEntry[]) {
    const audio = audioRef.current
    if (!audio || !pos) return

    const entry = playlist[pos.trackIndex]
    if (!entry) return

    const url = trackPublicUrl(entry.track.filePath)
    if (audio.src !== url) {
      audio.src = url
    }
    audio.currentTime = pos.offsetSeconds
    if (playing && hasInteractedRef.current && !isPausedRef.current) {
      audio.play().catch(() => {})
    } else {
      audio.pause()
    }
  }

  function scheduleNextAdvance(
    tracks: ReturnType<typeof toPlaylistTracks>,
    pos: RadioPosition | null,
    playing: boolean,
  ) {
    if (advanceTimerRef.current) clearTimeout(advanceTimerRef.current)
    if (!pos || !playing || tracks.length === 0) return

    const remaining = secondsUntilNextBoundary(tracks, pos)
    advanceTimerRef.current = setTimeout(() => resync(), Math.max(250, remaining * 1000))
  }

  useEffect(() => {
    resync()

    const channel = supabase
      .channel('radio-room')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'radio_state' }, resync)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'playlist_items' }, resync)
      .on('presence', { event: 'sync' }, () => {
        setListenerCount(Math.max(1, Object.keys(channel.presenceState()).length))
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await channel.track({ joined_at: new Date().toISOString() })
        }
      })

    return () => {
      supabase.removeChannel(channel)
      if (advanceTimerRef.current) clearTimeout(advanceTimerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function handlePlayClick() {
    const audio = audioRef.current
    if (!audio) return

    if (!hasInteractedRef.current) {
      hasInteractedRef.current = true
      isPausedRef.current = false
      setUserStarted(true)
      setIsPaused(false)
      audio.play().catch(() => {})
      return
    }

    const nextPaused = !isPausedRef.current
    isPausedRef.current = nextPaused
    setIsPaused(nextPaused)
    if (nextPaused) {
      audio.pause()
    } else {
      audio.play().catch(() => {})
    }
  }

  const currentEntry = position ? entries[position.trackIndex] : undefined
  const nextEntry = position && entries.length > 0 ? entries[(position.trackIndex + 1) % entries.length] : undefined

  return (
    <div className="radio-screen">
      <div className="radio-screen__header">
        <span className="radio-screen__station">BIGUNDER FM</span>
        <OnAirBadge isPlaying={isPlaying} />
      </div>

      <CoverArt
        coverUrl={currentEntry ? coverPublicUrl(currentEntry.track.coverPath) : null}
        alt={currentEntry?.track.title ?? 'BIGUNDER FM'}
      />

      <div className="radio-screen__track-info">
        <div className="radio-screen__artist">{currentEntry?.track.artist ?? '—'}</div>
        <div className="radio-screen__title">{currentEntry?.track.title ?? 'Tune in...'}</div>
      </div>

      <ProgressBar
        offsetSeconds={position?.offsetSeconds ?? 0}
        durationSeconds={currentEntry?.track.durationSeconds ?? 0}
      />

      <button className="radio-screen__play" onClick={handlePlayClick}>
        {userStarted && !isPaused ? '❚❚' : '▶'}
      </button>

      {nextEntry && (
        <div className="radio-screen__next">
          NEXT: {nextEntry.track.artist} — {nextEntry.track.title}
        </div>
      )}

      <div className="radio-screen__listeners">{listenerCount} listening</div>

      <audio ref={audioRef} />
    </div>
  )
}
