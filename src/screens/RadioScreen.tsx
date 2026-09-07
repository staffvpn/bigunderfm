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

// Module-level singleton, created once and reused across every mount of
// RadioScreen for the lifetime of the page. Rendering an <audio> element
// straight in JSX meant every mount (e.g. leaving the Radio tab and
// coming back) created a brand new DOM node — and since removing a media
// element from the document does NOT stop its playback, careful
// pause-on-unmount cleanup was the only thing standing between that and
// two elements playing simultaneously. A single shared element removes
// the failure mode at the root: there is only ever one to begin with, no
// discipline required elsewhere. It doesn't need to be in the DOM at all
// to play — createMediaElementSource (useAudioAnalyser.ts) works on a
// detached element too.
//
// Deliberately NOT setting crossOrigin here (it was 'anonymous' before,
// only for the equalizer's Web Audio analysis) — seeking to a non-zero
// offset was consistently landing back at 0:00 specifically on Telegram's
// iOS WebView, which matches a known class of WebKit bugs where
// crossOrigin interacts badly with Range-request seeking. Actual
// playback of a cross-origin file works fine without it; the only cost
// is the equalizer's analyser reading zeroed (silent) data instead of
// real levels, which is a purely cosmetic degradation — correct playback
// position matters far more than the bar animation.
const sharedAudio: HTMLAudioElement = document.createElement('audio')

export function RadioScreen() {
  const [entries, setEntries] = useState<PlaylistEntry[]>([])
  const [position, setPosition] = useState<RadioPosition | null>(null)
  // Ticks once a second off the audio element so the progress bar actually
  // moves; `position` only changes on a resync, which is minutes apart.
  const [displayOffset, setDisplayOffset] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [userStarted, setUserStarted] = useState(false)
  const [isPaused, setIsPaused] = useState(true)
  const audioRef = useRef<HTMLAudioElement>(sharedAudio)
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
  // Bumped every time applyPositionToAudio starts a new seek/play attempt.
  // Its async continuations (loadedmetadata, seeked, the timeout fallback)
  // capture the value at their own start and check it before acting — if
  // a newer attempt has since started (e.g. the user pressed Play while an
  // earlier resync's metadata was still loading), the stale one is a
  // silent no-op instead of applying an outdated seek on top of a newer one.
  const playbackGenRef = useRef(0)
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

  // The one place currentTime AND play() ever get coordinated — every
  // caller (a fresh track load, a plain resync, or the user pressing
  // Play) MUST go through this, not call audio.play() directly.
  //
  // Order matters here in a way that's easy to get backwards: this used
  // to seek first and only call play() once the seek had verifiably
  // landed (waiting on 'seeked', then polling currentTime directly when
  // 'seeked' turned out not to fire reliably on Telegram's iOS WebView
  // either) — but neither approach ever actually got the seek to land on
  // that platform AT ALL (confirmed live, repeatedly, after ruling out
  // stale/orphaned elements). The same code works correctly on desktop.
  // That combination — desktop fine, iOS Safari/WebKit specifically
  // broken, 100% reproducible — matches a known WebKit bug class: setting
  // currentTime BEFORE the first play() inside a user-gesture / audio
  // engine startup can be silently reset back to 0 once the session
  // actually engages. The fix iOS itself expects is the opposite order:
  // call play() first, THEN set currentTime.
  function seekAndSync(audio: HTMLAudioElement, targetOffset: number, shouldPlay: boolean) {
    if (!shouldPlay) {
      audio.currentTime = targetOffset
      audio.pause()
      return
    }

    const wasPaused = audio.paused
    if (!wasPaused) {
      // Already playing (a routine resync, nothing actually changed) —
      // the audio session is already engaged, a plain seek is safe.
      audio.currentTime = targetOffset
      return
    }

    // Silence it before play() so there's no audible pop at full volume
    // before the fade-in ramp takes over once real output begins.
    audio.volume = 0
    audio.play().catch(() => {})
    // Setting currentTime right after — not before — play(). Also
    // reapplied inside 'playing' as a second attempt: some engines still
    // don't honor a seek issued before output has genuinely started.
    audio.currentTime = targetOffset
    audio.addEventListener(
      'playing',
      () => {
        audio.currentTime = targetOffset
        fadeVolume(audio, 0, 1, FADE_SECONDS * 1000)
      },
      { once: true },
    )
  }

  function applyPositionToAudio(pos: RadioPosition | null, playing: boolean, playlist: PlaylistEntry[]) {
    const audio = audioRef.current
    if (!audio || !pos) return

    const entry = playlist[pos.trackIndex]
    if (!entry) return

    const url = trackPublicUrl(entry.track.filePath)
    const shouldPlay = playing && hasInteractedRef.current && !isPausedRef.current
    const targetOffset = pos.offsetSeconds
    const gen = ++playbackGenRef.current

    if (audio.src !== url) {
      audio.src = url
    }

    // Same-src does NOT mean metadata is actually ready — e.g. the user
    // pressing Play can call this again while an earlier call's src
    // assignment is still loading. Assuming it was ready (the previous bug
    // here) meant currentTime got assigned before the browser could
    // actually act on it, silently doing nothing; the seek that DID
    // eventually apply came from whichever 'loadedmetadata' listener fired
    // later — using ITS OWN (possibly stale) shouldPlay/targetOffset, not
    // this call's, since JS closures don't get updated after the fact.
    if (audio.readyState < HTMLMediaElement.HAVE_METADATA) {
      audio.addEventListener(
        'loadedmetadata',
        () => {
          if (playbackGenRef.current !== gen) return
          seekAndSync(audio, targetOffset, shouldPlay)
        },
        { once: true },
      )
      return
    }

    seekAndSync(audio, targetOffset, shouldPlay)
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
    // boundary) then loads the next track and seekAndSync() fades it back
    // in. Only worth doing if there's actually enough left to fade.
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
      // Removing the <audio> element from the DOM does NOT stop it playing
      // — browsers keep an orphaned media element's playback running in
      // the background indefinitely unless it's explicitly paused. Without
      // this, leaving the Radio tab and coming back left the OLD element
      // silently still playing in the background while a brand new one
      // started too — two tracks audible at once, which is exactly what
      // got reported live.
      audioRef.current?.pause()
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
    </div>
  )
}
