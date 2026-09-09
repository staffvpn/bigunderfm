import { useEffect, useRef, useState } from 'react'
import { STREAM_HOST, STREAM_URL, decodeHtmlEntities } from '../lib/radioServer'
import { pickNextBackground } from '../lib/backgrounds'
import { OnAirBadge } from '../components/OnAirBadge'
import { Equalizer } from '../components/Equalizer'
import { useAudioAnalyser } from '../lib/useAudioAnalyser'

interface BackgroundLayers {
  a: string | undefined
  b: string | undefined
  active: 'a' | 'b'
}

// Real, always-on broadcast — Icecast (distribution) + Liquidsoap
// (scheduling/encoding) running on a dedicated VPS, streaming the shared
// playlist continuously. Every listener just connects to this URL and
// plays it; there is no seeking, no per-client position math, and no
// virtual timeline to fall out of sync with. This replaces the previous
// "virtual synced timeline" design (client-side seek against a shared
// anchor timestamp), which never reliably seeked on iOS/WebKit — a live
// stream structurally can't have that bug, there is nothing to seek.
// HTTPS via nginx + Let's Encrypt on the VPS, fronting Icecast — plain
// http:// was silently blocked as mixed content by the browser since the
// app itself is served over https://, which looked like "nothing works"
// with no visible error. sslip.io is a free wildcard DNS that resolves
// <ip-with-dashes>.sslip.io back to that literal IP, enough for Let's
// Encrypt's HTTP-01 challenge without owning a real domain.

export function RadioScreen() {
  const [userStarted, setUserStarted] = useState(false)
  const [isPaused, setIsPaused] = useState(true)
  // Connecting to a live stream isn't instant (DNS + TLS + TCP + enough
  // buffered audio to actually start, ~1-2s) — without this the button
  // flips to the pause icon the instant it's clicked while nothing is
  // audible yet, which reads as "stuck"/"not working" rather than "loading".
  const [isBuffering, setIsBuffering] = useState(false)
  const [nowPlaying, setNowPlaying] = useState<{ artist: string; title: string } | null>(null)
  const [connectError, setConnectError] = useState(false)
  // A random poster image from src/assets/backgrounds/ behind everything,
  // re-rolled whenever the track actually changes (see the effect below
  // keyed on nowPlaying?.title) — purely decorative/mood, not tied to any
  // specific track's own artwork. Two alternating layers (not one image
  // swapped in place) — background-image isn't itself a CSS-transitionable
  // property, so crossfading between images means keeping both the outgoing
  // and incoming image each on their own layer and animating opacity
  // between the two layers instead (see .radio-screen__bg-layer).
  const [bgLayers, setBgLayers] = useState<BackgroundLayers>(() => ({
    a: pickNextBackground(),
    b: undefined,
    active: 'a',
  }))
  const audioRef = useRef<HTMLAudioElement>(null)
  const { analyser, resume: resumeAnalyser } = useAudioAnalyser(audioRef)

  // isPausedRef mirrors the isPaused state but is readable from the
  // mount-once effect's closures below without going stale — those
  // closures capture whatever isPaused was on first render forever,
  // while .current always reflects the latest value. Needed so a
  // reconnect attempt (fired from an 'error'/'stalled' handler registered
  // once) can tell "did the user actually want this stopped" from "did
  // the connection just drop under a still-active listen".
  const isPausedRef = useRef(true)
  useEffect(() => {
    isPausedRef.current = isPaused
  }, [isPaused])
  const reconnectAttemptsRef = useRef(0)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Guards against a real, observed race: iOS can fire the Media Session
  // 'play' action AND the in-app button's onClick for the same physical
  // tap (the WebView's own click and the OS-level "now playing" control
  // syncing back to it). handlePlayClick's `isBuffering` check doesn't
  // catch this — React state updates aren't synchronous, so a second
  // invocation landing in the same tick reads the same stale `false` the
  // first one did, and both proceed to open their own real connection to
  // /radio. Server logs confirmed this: two genuinely separate, several-
  // -second-long stream connections opening at the exact same timestamp,
  // repeatedly. A plain ref flips synchronously and is read/set before
  // either invocation yields, so the second call sees it immediately.
  const connectingRef = useRef(false)

  useEffect(() => {
    // Icecast exposes the currently-playing title itself — poll it instead
    // of trying to derive "now playing" from playlist position, since the
    // server (Liquidsoap) is the only thing that actually knows where in
    // the broadcast we are.
    async function pollNowPlaying() {
      try {
        const resp = await fetch(`${STREAM_HOST}/status-json.xsl`)
        const data = await resp.json()
        const rawTitle: string | undefined = data?.icestats?.source?.title
        if (rawTitle) {
          const title = decodeHtmlEntities(rawTitle)
          const [artist, ...rest] = title.split(' - ')
          setNowPlaying({ artist, title: rest.join(' - ') || title })
        }
      } catch {
        // Stream metadata is best-effort — playback itself doesn't depend on it.
      }
    }
    pollNowPlaying()
    const nowPlayingTimer = setInterval(pollNowPlaying, 10000)

    // Reflect the audio element's actual state rather than just the click
    // intent — 'waiting' fires while it's connecting/buffering (including
    // the initial connect and any mid-stream stall), 'playing' fires the
    // moment sound genuinely starts coming out.
    const audio = audioRef.current
    const MAX_RECONNECT_ATTEMPTS = 5

    function reconnect() {
      if (!audio) return
      connectingRef.current = true
      audio.src = STREAM_URL
      audio.play().catch(() => {})
    }

    // Icecast connections do drop mid-listen sometimes (a flaky mobile
    // network, a WebKit quirk with long-lived unbounded streams — this
    // isn't specific to us, real radio apps hit the same thing). Without
    // this, a drop just silently killed playback and left the listener
    // stuck looking at a paused button with no idea why. Retries with
    // a short growing backoff instead, only while the user still actually
    // wants to be listening (isPausedRef.current === false) — never
    // reconnects into someone who explicitly hit pause.
    function scheduleReconnect() {
      if (isPausedRef.current) return
      // A reconnect is already pending/in flight — the duplicate-connection
      // bug this guards against is exactly two 'error' events (one per
      // stray parallel connection) each independently calling this.
      if (reconnectTimerRef.current || connectingRef.current) return
      if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
        setIsBuffering(false)
        setIsPaused(true)
        setConnectError(true)
        return
      }
      setIsBuffering(true)
      const delay = Math.min(1000 * 2 ** reconnectAttemptsRef.current, 10000)
      reconnectAttemptsRef.current += 1
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null
        reconnect()
      }, delay)
    }

    function handleWaiting() {
      setIsBuffering(true)
    }
    function handlePlaying() {
      connectingRef.current = false
      setIsBuffering(false)
      setConnectError(false)
      reconnectAttemptsRef.current = 0
    }
    function handleAudioError() {
      connectingRef.current = false
      scheduleReconnect()
    }
    // A live stream "ending" is never intentional on the server side —
    // treat it exactly like a dropped connection.
    audio?.addEventListener('waiting', handleWaiting)
    audio?.addEventListener('stalled', handleWaiting)
    audio?.addEventListener('playing', handlePlaying)
    audio?.addEventListener('error', handleAudioError)
    audio?.addEventListener('ended', handleAudioError)

    return () => {
      clearInterval(nowPlayingTimer)
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
      audio?.removeEventListener('waiting', handleWaiting)
      audio?.removeEventListener('stalled', handleWaiting)
      audio?.removeEventListener('playing', handlePlaying)
      audio?.removeEventListener('error', handleAudioError)
      audio?.removeEventListener('ended', handleAudioError)
      audio?.pause()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Shared by the play button AND Media Session action handlers below.
  function setPlaybackIntent(playing: boolean) {
    const audio = audioRef.current
    if (!audio) return

    setUserStarted(true)
    setIsPaused(!playing)

    if (!playing) {
      // Still safe/cheap to call here even though this branch doesn't
      // touch src — first-ever interaction being a pause (e.g. a stray
      // Media Session action) is an edge case, not one worth special-
      // casing out.
      resumeAnalyser()
      // An explicit pause cancels any in-flight reconnect attempt — a
      // drop-triggered retry landing a second after the user paused would
      // otherwise silently start the stream back up underneath them.
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
      reconnectAttemptsRef.current = 0
      connectingRef.current = false
      setIsBuffering(false)
      setConnectError(false)
      audio.pause()
      return
    }

    // A connection attempt is already in flight — iOS can fire the Media
    // Session 'play' action for the same physical tap that also fired the
    // button's onClick, and this function is the one thing both paths
    // funnel through. Without this, both calls proceed and each opens its
    // own real connection to /radio; server logs confirmed exactly that,
    // twice, as two genuinely separate several-second-long stream
    // connections landing at the same timestamp. A ref (not React state)
    // because it must be visible to the second call synchronously, before
    // either has yielded back to the event loop for a re-render.
    if (connectingRef.current) return
    connectingRef.current = true

    // Fresh, explicit attempt — forget any exhausted auto-reconnect streak
    // from before so this gets the full retry budget again.
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
    reconnectAttemptsRef.current = 0
    setConnectError(false)

    // Set proactively on click rather than waiting for the 'waiting' event
    // — that event can lag slightly behind src/load(), and the button
    // should show "connecting" from the very first frame after the tap.
    // Cleared by the 'playing' handler once sound actually starts, or by
    // 'error' if the connection fails outright.
    setIsBuffering(true)

    // A live stream has no "resume from where I left off" — reconnecting
    // always joins wherever the broadcast currently is, exactly like tuning
    // in a real radio station. Reassigning `src` forces a fresh connection
    // rather than resuming a stale/stalled buffer from before a pause.
    if (audio.src !== STREAM_URL) {
      audio.src = STREAM_URL
    } else {
      audio.load()
    }

    // Tap the Web Audio graph AFTER the element already has a resource
    // attached, not before (as this did until now) — on the very first
    // ever play, `resumeAnalyser()` used to run while `audio.src` was
    // still empty, and createMediaElementSource()'d an element with
    // nothing assigned to it yet. Some browsers' analyser only starts
    // receiving real decoded samples if the element already had a
    // resource at tap-creation time; before the live-stream rewrite, src
    // was always already set by the time this ran (the old virtual-
    // timeline logic assigned it well before any click), which is very
    // likely why the equalizer used to react to real audio and stopped
    // once src started getting assigned inside this same click instead.
    // Still fully synchronous — no await between here and audio.play()
    // below — so the user-gesture requirement for AudioContext.resume()
    // is untouched by the reorder.
    resumeAnalyser()

    audio.play().catch(() => {})
  }

  function handlePlayClick() {
    // Ignore taps while a connection attempt is already in flight — a
    // second overlapping audio.load()/play() here just restarts the
    // buffering clock rather than doing anything useful.
    if (isBuffering) return
    setPlaybackIntent(isPaused)
  }

  // Lock-screen / notification-shade media controls. This does NOT achieve
  // background playback — iOS/Android suspend the WebView's JS entirely
  // once Telegram itself is backgrounded, which stops audio regardless of
  // Media Session. It only makes the already-open foreground screen show
  // up properly in system media UI instead of not appearing there at all.
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

  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    navigator.mediaSession.metadata = new MediaMetadata({
      title: nowPlaying?.title ?? 'BIGUNDER FM',
      artist: nowPlaying?.artist ?? '',
      artwork: [{ src: `${location.origin}/logo.png`, sizes: '512x512', type: 'image/png' }],
    })
  }, [nowPlaying?.title, nowPlaying?.artist])

  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    navigator.mediaSession.playbackState = userStarted && !isPaused ? 'playing' : 'paused'
  }, [userStarted, isPaused])

  // Re-roll the background whenever the track actually changes (not on
  // every 10s metadata poll — nowPlaying?.title only changes value when
  // the broadcast genuinely moves to a different track). Loads the new
  // image onto whichever layer is currently OFF-screen, then flips which
  // layer is "active" — the CSS transition on .radio-screen__bg-layer's
  // opacity/transform/filter is what actually animates the swap.
  useEffect(() => {
    if (!nowPlaying?.title) return
    setBgLayers((prev) => {
      const idleLayer = prev.active === 'a' ? 'b' : 'a'
      return { ...prev, [idleLayer]: pickNextBackground(), active: idleLayer }
    })
  }, [nowPlaying?.title])

  return (
    <div className="radio-screen">
      <div
        className={`radio-screen__bg-layer${bgLayers.active === 'a' ? ' radio-screen__bg-layer--active' : ''}`}
        style={bgLayers.a ? { backgroundImage: `url(${bgLayers.a})` } : undefined}
        aria-hidden="true"
      />
      <div
        className={`radio-screen__bg-layer${bgLayers.active === 'b' ? ' radio-screen__bg-layer--active' : ''}`}
        style={bgLayers.b ? { backgroundImage: `url(${bgLayers.b})` } : undefined}
        aria-hidden="true"
      />
      <div className="radio-screen__scrim" aria-hidden="true" />

      <div className="radio-screen__content">
        <div className="radio-screen__header">
          <span className="radio-screen__station">BIGUNDER FM</span>
          <OnAirBadge isPlaying={userStarted && !isPaused && !isBuffering} />
        </div>

        <div className="radio-screen__artist">{nowPlaying?.artist ?? '—'}</div>
        <div className="radio-screen__title">
          {userStarted && !isPaused && isBuffering
            ? 'Подключение...'
            : (nowPlaying?.title ?? 'Загрузка...')}
        </div>

        <Equalizer analyser={analyser} isPlaying={userStarted && !isPaused && !isBuffering} />

        <button
          className={`radio-screen__play${isBuffering ? ' radio-screen__play--buffering' : ''}`}
          onClick={handlePlayClick}
          disabled={userStarted && !isPaused && isBuffering}
        >
          {/* CSS-drawn shapes, not Unicode glyphs (▶ renders as a colored
              emoji glyph on iOS instead of a plain triangle) — this way play
              and pause are guaranteed the same visual style everywhere. */}
          {userStarted && !isPaused ? <span className="icon-pause" /> : <span className="icon-play" />}
        </button>

        {connectError && (
          <div className="radio-screen__error">Не удалось подключиться. Нажмите play, чтобы попробовать снова.</div>
        )}

        <audio ref={audioRef} crossOrigin="anonymous" preload="none" />
      </div>
    </div>
  )
}
