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
import { Equalizer } from '../components/Equalizer'
import { useAudioAnalyser } from '../lib/useAudioAnalyser'

/** How long before a track boundary to start buffering the next file. */
const PRELOAD_LEAD_SECONDS = 5
/** Fade-out-then-fade-in duration around each track transition. */
const FADE_SECONDS = 2

export function RadioScreen() {
  const [entries, setEntries] = useState<PlaylistEntry[]>([])
  const [position, setPosition] = useState<RadioPosition | null>(null)
  // Ticks once a second off the audio element so the progress bar actually
  // moves; `position` only changes on a resync, which is minutes apart.
  const [displayOffset, setDisplayOffset] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [userStarted, setUserStarted] = useState(false)
  const [isPaused, setIsPaused] = useState(true)
  const audioRef = useRef<HTMLAudioElement>(null)
  const advanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const preloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fadeOutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fadeIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
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
  const { analyser, resume: resumeAnalyser } = useAudioAnalyser(audioRef)

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

  // Ramps audio.volume from `from` to `to` over durationMs. Cancels any
  // fade already in progress first — a skip or a fresh play during a
  // fade-out shouldn't leave two ramps fighting over the same property.
  function fadeVolume(audio: HTMLAudioElement, from: number, to: number, durationMs: number) {
    if (fadeIntervalRef.current) clearInterval(fadeIntervalRef.current)
    audio.volume = from
    const steps = 20
    let step = 0
    fadeIntervalRef.current = setInterval(() => {
      step++
      audio.volume = from + (to - from) * (step / steps)
      if (step >= steps) {
        audio.volume = to
        if (fadeIntervalRef.current) clearInterval(fadeIntervalRef.current)
        fadeIntervalRef.current = null
      }
    }, durationMs / steps)
  }

  // Starts playback with a fade-in, but ONLY when actually transitioning
  // from paused — seekAndSync's "already playing, just resyncing" path also
  // calls this, and re-triggering a fade every routine resync (nothing
  // audibly changed) would be wrong, not just redundant.
  function beginPlayback(audio: HTMLAudioElement) {
    const wasPaused = audio.paused
    if (wasPaused) {
      // Silence it BEFORE play() even starts (no audible pop at full
      // volume), then wait for the 'playing' event — which fires once
      // output has actually begun, after whatever buffering a fresh
      // track/seek needs — before starting the ramp. Starting the ramp
      // right after calling play() instead (the previous bug here) timed
      // it against wall-clock time from the play() *call*, not from when
      // sound actually started: if buffering took even close to as long
      // as the fade itself, the ramp could finish before anything was
      // audible at all, sounding like a hard start with no fade — this
      // never showed up for the fade-OUT (an already-playing, already
      // buffered element has no such delay), only for fade-IN.
      audio.volume = 0
      audio.addEventListener('playing', () => fadeVolume(audio, 0, 1, FADE_SECONDS * 1000), { once: true })
    }
    audio.play().catch(() => {})
  }

  // The one place currentTime ever gets assigned when we might also want
  // to play — every caller (a fresh track load, a plain resync, or the
  // user pressing Play) MUST go through this, not call audio.play()
  // directly, or it can start before a pending seek has actually landed.
  function seekAndSync(audio: HTMLAudioElement, targetOffset: number, shouldPlay: boolean) {
    // Captured BEFORE assigning currentTime — right after a fresh src load
    // (or before any real seek) this reflects where playback actually is,
    // so comparing it against targetOffset tells us whether a real seek is
    // even needed. Reading audio.currentTime back AFTER assignment can't
    // do this: that always reflects the pending seek's TARGET immediately,
    // not whether the browser has actually finished getting there.
    const previousTime = audio.currentTime
    audio.currentTime = targetOffset

    if (!shouldPlay) {
      audio.pause()
      return
    }

    // Landing within a second of where we already were means there was
    // nothing meaningful to seek (e.g. a genuine near-0:00 start) —
    // 'seeked' may not even fire for that, so just play.
    if (Math.abs(previousTime - targetOffset) < 1) {
      beginPlayback(audio)
      return
    }

    // Otherwise this is a real seek, and it's ASYNC — the browser still
    // has to fetch the byte range for that offset, which on a cold network
    // load (no HTTP cache yet) can take real time, more for a longer file.
    // Calling play() before it lands plays whatever's already buffered —
    // the start of the file — until the seek catches up: audibly
    // indistinguishable from "it restarted from 0:00". A warm/cached load
    // (e.g. switching tabs back to Radio) makes the seek resolve near
    // instantly, which is why this only showed up on a fresh load or a
    // long track. Wait for the real 'seeked' event rather than guessing a
    // fixed delay — a fixed timeout short enough to feel responsive for a
    // short track is exactly the kind of thing that loses the race against
    // a slow seek on a much longer one (this app has a ~25 min track in
    // rotation). The long setTimeout here is a last-resort unstick, not
    // the expected path — it should essentially never fire.
    let started = false
    const startPlayback = () => {
      if (started) return
      started = true
      beginPlayback(audio)
    }
    audio.addEventListener('seeked', startPlayback, { once: true })
    setTimeout(startPlayback, 10000)
  }

  function applyPositionToAudio(pos: RadioPosition | null, playing: boolean, playlist: PlaylistEntry[]) {
    const audio = audioRef.current
    if (!audio || !pos) return

    const entry = playlist[pos.trackIndex]
    if (!entry) return

    const url = trackPublicUrl(entry.track.filePath)
    const shouldPlay = playing && hasInteractedRef.current && !isPausedRef.current

    if (audio.src !== url) {
      audio.src = url
      // Seeking immediately after assigning `src` is dropped by browsers
      // that haven't finished resource selection yet — defer until the
      // media actually has metadata and the seek can land.
      const targetOffset = pos.offsetSeconds
      audio.addEventListener('loadedmetadata', () => seekAndSync(audio, targetOffset, shouldPlay), { once: true })
      return
    }

    seekAndSync(audio, pos.offsetSeconds, shouldPlay)
  }

  function scheduleNextAdvance(
    tracks: ReturnType<typeof toPlaylistTracks>,
    pos: RadioPosition | null,
    playing: boolean,
    playlist: PlaylistEntry[],
  ) {
    if (advanceTimerRef.current) clearTimeout(advanceTimerRef.current)
    if (preloadTimerRef.current) clearTimeout(preloadTimerRef.current)
    if (fadeOutTimerRef.current) clearTimeout(fadeOutTimerRef.current)
    if (!pos || !playing || tracks.length === 0) return

    const remaining = secondsUntilNextBoundary(tracks, pos)
    advanceTimerRef.current = setTimeout(() => resync(), Math.max(250, remaining * 1000))

    // Fade the current track out right before it ends, so the swap at the
    // boundary isn't a hard cut — resync() (scheduled above, at the same
    // boundary) then loads the next track and beginPlayback() fades it
    // back in. Only worth doing if there's actually enough left to fade.
    if (remaining > FADE_SECONDS) {
      fadeOutTimerRef.current = setTimeout(
        () => {
          const audio = audioRef.current
          if (audio && !audio.paused) {
            fadeVolume(audio, audio.volume, 0, FADE_SECONDS * 1000)
          }
        },
        (remaining - FADE_SECONDS) * 1000,
      )
    }

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
      // No presence 'sync' listener here: this client only needs to track
      // itself as present (below) so the count is accurate elsewhere — the
      // count itself is displayed in the admin Controls tab, see
      // useListenerCount.ts.
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
      if (fadeOutTimerRef.current) clearTimeout(fadeOutTimerRef.current)
      if (fadeIntervalRef.current) clearInterval(fadeIntervalRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Shared by the play button AND the Media Session action handlers below
  // (lock screen / notification shade play-pause) — both just express a
  // desired playing/paused intent, so they go through the same path
  // rather than each reimplementing it slightly differently.
  function setPlaybackIntent(playing: boolean) {
    const audio = audioRef.current
    if (!audio) return

    // Must run synchronously inside the originating user-gesture call
    // stack (a click, or a Media Session action) — Safari/iOS only
    // resumes a suspended AudioContext from within one.
    resumeAnalyser()

    hasInteractedRef.current = true
    isPausedRef.current = !playing
    setUserStarted(true)
    setIsPaused(!playing)

    if (!playing) {
      audio.pause()
      return
    }

    // Recompute a fresh position instead of trusting `position` state,
    // which is only as recent as the last resync and can be meaningfully
    // stale by the time someone actually presses Play — then feed it
    // through the exact same seek-then-play discipline every other
    // playback change uses (resync() -> applyPositionToAudio ->
    // seekAndSync). Calling audio.play() directly here (the previous bug)
    // trusted whatever currentTime the element already happened to have,
    // which isn't guaranteed to be seeked yet on a fresh mount.
    resync()
  }

  function handlePlayClick() {
    // Before the first interaction isPausedRef defaults to true, which
    // conveniently also means "start playing" here — same toggle either way.
    setPlaybackIntent(isPausedRef.current)
  }

  // Lock-screen / notification-shade media controls. This does NOT achieve
  // background playback — iOS/Android suspend the WebView's JS entirely
  // once Telegram itself is backgrounded, which stops audio regardless of
  // Media Session, and this app has no real stream server to keep
  // advancing the playlist even if it didn't. It only makes the
  // already-open foreground screen show up properly in system media UI
  // instead of not appearing there at all.
  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    navigator.mediaSession.setActionHandler('play', () => setPlaybackIntent(true))
    navigator.mediaSession.setActionHandler('pause', () => setPlaybackIntent(false))
    return () => {
      navigator.mediaSession.setActionHandler('play', null)
      navigator.mediaSession.setActionHandler('pause', null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const currentEntry = position ? entries[position.trackIndex] : undefined
  const nextEntry = position && entries.length > 0 ? entries[(position.trackIndex + 1) % entries.length] : undefined

  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    navigator.mediaSession.metadata = new MediaMetadata({
      title: currentEntry?.track.title ?? 'BIGUNDER FM',
      artist: currentEntry?.track.artist ?? '',
      artwork: [
        {
          src: (currentEntry ? coverPublicUrl(currentEntry.track.coverPath) : null) ?? `${location.origin}/logo.png`,
          sizes: '512x512',
          type: currentEntry?.track.coverPath ? 'image/jpeg' : 'image/png',
        },
      ],
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentEntry?.track.id, currentEntry?.track.title, currentEntry?.track.artist, currentEntry?.track.coverPath])

  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    navigator.mediaSession.playbackState = userStarted && !isPaused ? 'playing' : 'paused'
  }, [userStarted, isPaused])

  return (
    <div className="radio-screen">
      <div className="radio-screen__header">
        <span className="radio-screen__station">BIGUNDER FM</span>
        <OnAirBadge isPlaying={isPlaying} />
      </div>

      <div className="radio-screen__artist">{currentEntry?.track.artist ?? '—'}</div>
      <div className="radio-screen__title">{currentEntry?.track.title ?? 'Загрузка...'}</div>

      <Equalizer analyser={analyser} />

      <ProgressBar
        offsetSeconds={displayOffset}
        durationSeconds={currentEntry?.track.durationSeconds ?? 0}
      />

      <button className="radio-screen__play" onClick={handlePlayClick}>
        {/* CSS-drawn shapes, not Unicode glyphs (▶ renders as a colored
            emoji glyph on iOS instead of a plain triangle) — this way play
            and pause are guaranteed the same visual style everywhere. */}
        {userStarted && !isPaused ? (
          <span className="icon-pause" />
        ) : (
          <span className="icon-play" />
        )}
      </button>

      {nextEntry && (
        <div className="radio-screen__next">
          ДАЛЬШЕ • {nextEntry.track.artist} — {nextEntry.track.title}
        </div>
      )}

      <audio ref={audioRef} crossOrigin="anonymous" />
    </div>
  )
}
