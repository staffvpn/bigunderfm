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

/** How long before a track boundary to start buffering the next file. */
const PRELOAD_LEAD_SECONDS = 5

export function RadioScreen() {
  const [entries, setEntries] = useState<PlaylistEntry[]>([])
  const [position, setPosition] = useState<RadioPosition | null>(null)
  // Ticks once a second off the audio element so the progress bar actually
  // moves; `position` only changes on a resync, which is minutes apart.
  const [displayOffset, setDisplayOffset] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [listenerCount, setListenerCount] = useState(1)
  const [userStarted, setUserStarted] = useState(false)
  const [isPaused, setIsPaused] = useState(true)
  const audioRef = useRef<HTMLAudioElement>(null)
  const advanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const preloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
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
    setDisplayOffset(pos?.offsetSeconds ?? 0)
    applyPositionToAudio(pos, radioState.isPlaying, playlist)
    scheduleNextAdvance(tracks, pos, radioState.isPlaying, playlist)
  }

  // Playlist edits must NOT jump what is currently playing (spec §4: only an
  // explicit SKIP does that). Refresh the list for display only — the new
  // ordering takes effect on the next scheduled resync, i.e. the next loop pass.
  async function refreshEntriesOnly() {
    setEntries(await fetchPlaylist())
  }

  function applyPositionToAudio(pos: RadioPosition | null, playing: boolean, playlist: PlaylistEntry[]) {
    const audio = audioRef.current
    if (!audio || !pos) return

    const entry = playlist[pos.trackIndex]
    if (!entry) return

    const url = trackPublicUrl(entry.track.filePath)
    if (audio.src !== url) {
      audio.src = url
      // Seeking immediately after assigning `src` is dropped by browsers that
      // haven't finished resource selection yet — defer until the media has
      // metadata and the seek can actually land.
      const targetOffset = pos.offsetSeconds
      audio.addEventListener(
        'loadedmetadata',
        () => {
          audio.currentTime = targetOffset
        },
        { once: true },
      )
    } else {
      audio.currentTime = pos.offsetSeconds
    }
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
    playlist: PlaylistEntry[],
  ) {
    if (advanceTimerRef.current) clearTimeout(advanceTimerRef.current)
    if (preloadTimerRef.current) clearTimeout(preloadTimerRef.current)
    if (!pos || !playing || tracks.length === 0) return

    const remaining = secondsUntilNextBoundary(tracks, pos)
    advanceTimerRef.current = setTimeout(() => resync(), Math.max(250, remaining * 1000))

    // Best-effort warm-up: start buffering the next file a few seconds before
    // the boundary so the swap isn't a cold fetch. Not a crossfade.
    if (remaining > PRELOAD_LEAD_SECONDS && playlist.length > 0) {
      const nextEntry = playlist[(pos.trackIndex + 1) % playlist.length]
      if (nextEntry) {
        preloadTimerRef.current = setTimeout(
          () => {
            const preloadAudio = new Audio(trackPublicUrl(nextEntry.track.filePath))
            preloadAudio.preload = 'auto'
          },
          (remaining - PRELOAD_LEAD_SECONDS) * 1000,
        )
      }
    }
  }

  useEffect(() => {
    resync()

    const channel = supabase
      .channel('radio-room')
      // radio_state changes are admin skip/pause/resume — they must apply now.
      .on('postgres_changes', { event: '*', schema: 'public', table: 'radio_state' }, resync)
      // playlist_items changes are edits — display only, never mid-track jumps.
      .on('postgres_changes', { event: '*', schema: 'public', table: 'playlist_items' }, refreshEntriesOnly)
      .on('presence', { event: 'sync' }, () => {
        setListenerCount(Math.max(1, Object.keys(channel.presenceState()).length))
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await channel.track({ joined_at: new Date().toISOString() })
        }
      })

    // Mobile webviews throttle timers while backgrounded, so a listener coming
    // back to the app can be sitting on a long-stale track. Resync on return.
    function handleVisibilityChange() {
      if (document.visibilityState === 'visible') {
        resync()
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)

    // Drive the progress bar from the audio element itself.
    const tickTimer = setInterval(() => {
      const audio = audioRef.current
      if (audio && !audio.paused) {
        setDisplayOffset(audio.currentTime)
      }
    }, 1000)

    return () => {
      supabase.removeChannel(channel)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      clearInterval(tickTimer)
      if (advanceTimerRef.current) clearTimeout(advanceTimerRef.current)
      if (preloadTimerRef.current) clearTimeout(preloadTimerRef.current)
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
        offsetSeconds={displayOffset}
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
