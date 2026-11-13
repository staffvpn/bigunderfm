import { useEffect, useRef, useState } from 'react'
import { subscribeProgramChanged } from '../lib/presence'
import { LIVE_SERVER, RELAY_DELAY_MS, detachLive, isRelayRoute, playLive, statusUrl, decodeHtmlEntities, isStreamServerUp, mediaUrl } from '../lib/radioServer'
import { computeCurrentPosition } from '../lib/radioClock'
import { pickNextBackground, type BackgroundItem } from '../lib/backgrounds'
import { LikeButton } from '../components/LikeButton'
import { FitTitle } from '../components/FitTitle'
import { PauseIcon, PlayIcon } from '../components/Icons'
import { Socials } from '../components/Socials'
import { fetchPlaylist, fetchUpNextFilePath, toPlaylistTracks, type PlaylistEntry } from '../lib/tracks'
import { afterItem, fetchProgram, isLeftBehind, stationNow, tuneIn, type Program, type ProgramItem, type TuneIn } from '../lib/program'

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

const BACKGROUND_ROTATE_MS = 6 * 60 * 60 * 1000

// Fallback broadcast, used only while the VPS is unreachable (it lives with a
// single hosting provider, and when that provider went down the whole radio
// went silent with it). The library itself is in R2 on Cloudflare, so the app
// plays it straight from there: every listener computes the same position
// from this fixed anchor and the playlist durations, so everyone still hears
// roughly the same track at the same moment. No live hosts, no admin queue,
// no skip in this mode - just the rotation. As soon as a track ends and the
// VPS answers again, playback goes back to the real stream.
//
// Since the autorotation the fallback follows the station's planned air
// (/api/program: folders by time of day, hits, new tracks, jingles) rather
// than the plain playlist loop; the loop below stays only as a last resort
// for when that endpoint can't be reached.
const FALLBACK_ANCHOR = '2026-01-01T00:00:00Z'
// The backend pushes changes over the presence socket; this slow check only
// keeps the plan topped up (it is planned about an hour ahead) and the clock right.
const PROGRAM_POLL_MS = 5 * 60_000
// "Новинка" badge on the stream, same two weeks the rotation uses.
const NEW_FOR_MS = 14 * 86_400_000
const STREAM_CONNECT_TIMEOUT_MS = 5000
// The relay has to fetch a playlist and a first 8-second file before sound starts.
const RELAY_CONNECT_TIMEOUT_MS = 12000

// Remembers for a while that the VPS was down, so reopening the app goes
// straight to the fallback instead of first trying the dead server again.
const VPS_DOWN_KEY = 'bfm_vps_down_at'
const VPS_DOWN_TTL_MS = 15 * 60 * 1000
function rememberVpsDown(down: boolean) {
  try {
    if (down) localStorage.setItem(VPS_DOWN_KEY, String(Date.now()))
    else localStorage.removeItem(VPS_DOWN_KEY)
  } catch {
    // storage unavailable - not important
  }
}
function vpsRecentlyDown(): boolean {
  if (!LIVE_SERVER) return true
  try {
    const at = Number(localStorage.getItem(VPS_DOWN_KEY))
    return Number.isFinite(at) && at > 0 && Date.now() - at < VPS_DOWN_TTL_MS
  } catch {
    return false
  }
}

function normalize(s: string): string {
  return s.trim().toLowerCase()
}

export function RadioScreen({ onOpenGrid }: { onOpenGrid: () => void }) {
  const [userStarted, setUserStarted] = useState(false)
  const [isPaused, setIsPaused] = useState(true)
  // Connecting to a live stream isn't instant (DNS + TLS + TCP + enough
  // buffered audio to actually start, ~1-2s) — without this the button
  // flips to the pause icon the instant it's clicked while nothing is
  // audible yet, which reads as "stuck"/"not working" rather than "loading".
  const [isBuffering, setIsBuffering] = useState(false)
  const [nowPlaying, setNowPlaying] = useState<{ artist: string; title: string } | null>(null)
  const [connectError, setConnectError] = useState(false)
  // Loaded purely to find the current track's own duration and what's
  // next up — playback itself never depended on this (Liquidsoap is the
  // only thing that actually knows where in the broadcast we are), it's
  // matched against nowPlaying below by title/artist.
  const [entries, setEntries] = useState<PlaylistEntry[]>([])
  const [upNextPath, setUpNextPath] = useState<string | null>(null)
  // Square cover image OR looping video from src/assets/backgrounds/ —
  // re-rolled on a 6-hour timer (not per-track; the whole point is a
  // stable "vibe" that outlasts any one track), per explicit request.
  const [background, setBackground] = useState<BackgroundItem | undefined>(() => pickNextBackground())
  const audioRef = useRef<HTMLAudioElement>(null)

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

  // R2 fallback state (see FALLBACK_ANCHOR). Refs mirror state for the
  // mount-once event handlers, same reason as isPausedRef.
  const [fallback, setFallback] = useState(false)
  const fallbackRef = useRef(false)
  const [fallbackIndex, setFallbackIndex] = useState(-1)
  const fallbackIndexRef = useRef(-1)
  const fallbackErrorsRef = useRef(0)
  const pendingSeekRef = useRef<number | null>(null)
  const entriesRef = useRef<PlaylistEntry[]>([])

  function enterFallback() {
    fallbackRef.current = true
    setFallback(true)
  }

  // If the live stream hasn't produced sound within a few seconds of a tap,
  // assume the VPS is down and switch to the R2 fallback instead of leaving
  // the listener on "Подключение..." while a dead connection times out.
  const streamWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const streamPlayedRef = useRef(false)
  function clearStreamWatchdog() {
    if (streamWatchdogRef.current) clearTimeout(streamWatchdogRef.current)
    streamWatchdogRef.current = null
  }
  function armStreamWatchdog() {
    clearStreamWatchdog()
    streamPlayedRef.current = false
    streamWatchdogRef.current = setTimeout(() => {
      streamWatchdogRef.current = null
      if (fallbackRef.current || isPausedRef.current || streamPlayedRef.current) return
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
      reconnectAttemptsRef.current = 0
      rememberVpsDown(true)
      enterFallback()
      if (!tuneInFallback()) {
        connectingRef.current = false
        setIsBuffering(false)
        setIsPaused(true)
        setConnectError(true)
      }
    }, isRelayRoute() ? RELAY_CONNECT_TIMEOUT_MS : STREAM_CONNECT_TIMEOUT_MS)
  }

  // Wall-clock moment the playing file was at 0:00, so a seek from the lock screen can be undone.
  const trackZeroAtRef = useRef<number | null>(null)
  function startFallbackAudio(track: { artist: string; title: string; filePath: string }, offsetSeconds: number): boolean {
    const audio = audioRef.current
    if (!audio) return false
    setNowPlaying({ artist: track.artist, title: track.title })
    pendingSeekRef.current = offsetSeconds > 2 ? offsetSeconds : null
    trackZeroAtRef.current = Date.now() - offsetSeconds * 1000
    connectingRef.current = true
    setIsBuffering(true)
    detachLive()
    audio.src = mediaUrl(track.filePath)
    audio.play().catch(() => {})
    return true
  }

  // The station's planned air (see lib/program.ts).
  const [program, setProgram] = useState<Program | null>(null)
  const programRef = useRef<Program | null>(null)
  const [fallbackItem, setFallbackItem] = useState<ProgramItem | null>(null)
  const fallbackItemIdRef = useRef<number | null>(null)

  const programFetchedAtRef = useRef(0)
  async function refreshProgram(): Promise<Program | null> {
    const fresh = await fetchProgram()
    if (fresh) {
      programFetchedAtRef.current = Date.now()
      programRef.current = fresh
      setProgram(fresh)
    }
    return fresh ?? programRef.current
  }

  function playProgramItem(t: TuneIn): boolean {
    fallbackItemIdRef.current = t.item.id
    setFallbackItem(t.item)
    fallbackIndexRef.current = -1
    setFallbackIndex(-1)
    return startFallbackAudio(t.item.track, t.offsetSeconds)
  }

  function playFallbackEntry(index: number, offsetSeconds: number): boolean {
    const list = entriesRef.current
    if (list.length === 0) return false
    const i = ((index % list.length) + list.length) % list.length
    const entry = list[i]
    fallbackItemIdRef.current = null
    setFallbackItem(null)
    fallbackIndexRef.current = i
    setFallbackIndex(i)
    return startFallbackAudio(entry.track, offsetSeconds)
  }

  // A track the station cut short (a timer starts exactly on time, or an
  // admin skipped it) is left at that moment rather than played to its end.
  const cuttingRef = useRef(false)
  useEffect(() => {
    const timer = setInterval(() => {
      const p = programRef.current
      const id = fallbackItemIdRef.current
      if (!p || id === null || !fallbackRef.current || isPausedRef.current || cuttingRef.current) return
      const item = p.items.find((it) => it.id === id)
      if (!item) return
      const planned = Date.parse(item.endsAt) - Date.parse(item.startsAt)
      if (planned > item.track.durationSeconds * 1000 - 3000) return
      if (stationNow(p) < Date.parse(item.endsAt)) return
      cuttingRef.current = true
      advanceFallback().finally(() => {
        cuttingRef.current = false
      })
    }, 1000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // What to play once the current fallback track is over (or failed to load).
  async function advanceFallback() {
    // A recent plan that already knows the next track needs no new request.
    const known = programRef.current
    const fresh = known && Date.now() - programFetchedAtRef.current < PROGRAM_POLL_MS * 2 && afterItem(known, fallbackItemIdRef.current)
    const p = fresh ? known : await refreshProgram()
    if (isPausedRef.current || !fallbackRef.current) return
    const next = p ? afterItem(p, fallbackItemIdRef.current) : null
    if (next) {
      playProgramItem(next)
      return
    }
    if (fallbackIndexRef.current >= 0) {
      playFallbackEntry(fallbackIndexRef.current + 1, 0)
    } else if (!tuneInFallback()) {
      connectingRef.current = false
      setIsBuffering(false)
      setIsPaused(true)
      setConnectError(true)
    }
  }

  // Joins the air wherever it currently is: the planned timeline when we
  // have it, the plain playlist loop otherwise.
  function tuneInFallback(): boolean {
    const live = programRef.current ? tuneIn(programRef.current) : null
    if (live) return playProgramItem(live)
    // Stale or missing program: start on the loop right away (this may be
    // running inside the tap that iOS requires for play()), and move onto
    // the real air as soon as it is known.
    refreshProgram().then((p) => {
      const t = p ? tuneIn(p) : null
      if (t && fallbackRef.current && !isPausedRef.current && fallbackItemIdRef.current === null) playProgramItem(t)
    })
    const list = entriesRef.current
    const pos = computeCurrentPosition(
      toPlaylistTracks(list),
      { anchorAt: FALLBACK_ANCHOR, isPlaying: true, pausedOffsetSeconds: null },
      new Date(),
    )
    if (!pos) return false
    return playFallbackEntry(pos.trackIndex, pos.offsetSeconds)
  }

  useEffect(() => {
    const playlistLoaded = fetchPlaylist().then((list) => {
      entriesRef.current = list
      setEntries(list)
    })

    // Find out up front whether the VPS is reachable at all. A dead server
    // can leave a connection attempt hanging for a long time before the
    // audio element reports an error, so without this the first tap would
    // just sit on "Подключение...".
    // Shows what the planned air has on right now (before play is pressed,
    // and while paused).
    function showProgramPreview(p: Program | null): boolean {
      const live = p ? tuneIn(p) : null
      if (!live) return false
      setFallbackItem(live.item)
      setFallbackIndex(-1)
      fallbackIndexRef.current = -1
      setNowPlaying({ artist: live.item.track.artist, title: live.item.track.title })
      return true
    }

    async function pollProgram() {
      const p = await refreshProgram()
      if (!p || !fallbackRef.current) return
      if (isPausedRef.current) {
        showProgramPreview(p)
      } else if (!connectingRef.current && isLeftBehind(p, fallbackItemIdRef.current)) {
        // The station moved on without us (an admin skipped the track).
        tuneInFallback()
      }
    }
    const programTimer = setInterval(pollProgram, PROGRAM_POLL_MS)
    const stopProgramPush = subscribeProgramChanged(pollProgram)

    if (vpsRecentlyDown()) enterFallback()
    Promise.all([isStreamServerUp(4000), playlistLoaded, refreshProgram()]).then(([up]) => {
      rememberVpsDown(!up)
      if (up) {
        // Came back while the app was closed - use the real stream again,
        // unless the fallback is already playing (it switches at track end).
        if (fallbackRef.current && isPausedRef.current) {
          fallbackRef.current = false
          setFallback(false)
          setFallbackIndex(-1)
          fallbackIndexRef.current = -1
          setFallbackItem(null)
          setNowPlaying(null)
          pollNowPlaying()
        }
        return
      }
      enterFallback()
      if (!isPausedRef.current) return
      if (showProgramPreview(programRef.current)) return
      // Show what's on the shared fallback timeline right away, before play.
      const pos = computeCurrentPosition(
        toPlaylistTracks(entriesRef.current),
        { anchorAt: FALLBACK_ANCHOR, isPlaying: true, pausedOffsetSeconds: null },
        new Date(),
      )
      const entry = pos ? entriesRef.current[pos.trackIndex] : undefined
      if (entry && isPausedRef.current) {
        fallbackIndexRef.current = pos!.trackIndex
        setFallbackIndex(pos!.trackIndex)
        setNowPlaying({ artist: entry.track.artist, title: entry.track.title })
      }
    })

    // Icecast exposes the currently-playing title itself — poll it instead
    // of trying to derive "now playing" from playlist position, since the
    // server (Liquidsoap) is the only thing that actually knows where in
    // the broadcast we are.
    async function pollNowPlaying() {
      if (!LIVE_SERVER || fallbackRef.current) return
      try {
        const resp = await fetch(statusUrl())
        const data = await resp.json()
        const rawTitle: string | undefined = data?.icestats?.source?.title
        if (rawTitle) {
          const title = decodeHtmlEntities(rawTitle)
          const [artist, ...rest] = title.split(' - ')
          const show = () => {
            if (!fallbackRef.current) setNowPlaying({ artist, title: rest.join(' - ') || title })
          }
          // The relayed air runs behind the server, so its title waits as long.
          if (isRelayRoute() && !isPausedRef.current) setTimeout(show, RELAY_DELAY_MS)
          else show()
        }
      } catch {
        // Stream metadata is best-effort — playback itself doesn't depend on it.
      }
    }
    pollNowPlaying()
    const nowPlayingTimer = setInterval(pollNowPlaying, 10000)

    // Mobile webviews throttle (or fully suspend) JS timers while the
    // screen is locked or the app is backgrounded — the 10s interval
    // above doesn't reliably catch up on its own once that happens, so a
    // listener coming back to the app can sit on a long-stale "now
    // playing" (and, downstream, a frozen "next track" — both come from
    // this same poll) indefinitely instead of within 10 seconds. Force a
    // fresh poll the moment the tab/app actually becomes visible again.
    function handleVisibilityChange() {
      if (document.visibilityState === 'visible') {
        pollNowPlaying()
        pollProgram()
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)

    // Background image pool rotates independently of track changes now —
    // every BACKGROUND_ROTATE_MS instead of every track.
    const backgroundTimer = setInterval(() => setBackground(pickNextBackground()), BACKGROUND_ROTATE_MS)

    // Reflect the audio element's actual state rather than just the click
    // intent — 'waiting' fires while it's connecting/buffering (including
    // the initial connect and any mid-stream stall), 'playing' fires the
    // moment sound genuinely starts coming out.
    const audio = audioRef.current
    const MAX_RECONNECT_ATTEMPTS = 5

    function reconnect() {
      if (!audio) return
      connectingRef.current = true
      armStreamWatchdog()
      playLive(audio)
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
        // The VPS is gone - keep the music going from R2 instead.
        enterFallback()
        reconnectAttemptsRef.current = 0
        if (tuneInFallback()) return
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
      streamPlayedRef.current = true
      clearStreamWatchdog()
      connectingRef.current = false
      setIsBuffering(false)
      setConnectError(false)
      reconnectAttemptsRef.current = 0
      fallbackErrorsRef.current = 0
    }
    function handleLoadedMetadata() {
      const t = pendingSeekRef.current
      pendingSeekRef.current = null
      if (!audio || t == null) return
      if (!Number.isFinite(audio.duration) || t < audio.duration - 5) {
        try {
          audio.currentTime = t
        } catch {
          // Seeking is a nicety (keeps listeners roughly in sync); starting
          // the track from the top is fine too.
        }
      }
    }
    // Radio cannot be wound: a seek from the lock screen snaps back to where the air is.
    function handleSeeked() {
      if (!audio || !fallbackRef.current || trackZeroAtRef.current === null) return
      const expected = (Date.now() - trackZeroAtRef.current) / 1000
      if (expected < 0 || (Number.isFinite(audio.duration) && expected > audio.duration - 1)) return
      if (Math.abs(audio.currentTime - expected) > 3) {
        try {
          audio.currentTime = expected
        } catch {
          // ignore
        }
      }
    }
    function handleAudioError() {
      connectingRef.current = false
      if (fallbackRef.current) {
        if (isPausedRef.current) return
        // A broken or missing file - move on to the next track rather than
        // stopping, but give up if nothing in the library will play.
        fallbackErrorsRef.current += 1
        if (fallbackErrorsRef.current > 5) {
          setIsBuffering(false)
          setIsPaused(true)
          setConnectError(true)
          return
        }
        setTimeout(() => {
          if (!isPausedRef.current) advanceFallback()
        }, 1000)
        return
      }
      scheduleReconnect()
    }
    async function handleEnded() {
      if (!fallbackRef.current) {
        handleAudioError()
        return
      }
      if (isPausedRef.current) return
      // Between tracks is the one moment switching back is seamless. The
      // backend checks the radio server every minute; only when it says the
      // server is back (or we have no word from it) is it worth the wait.
      if (programRef.current?.vpsUp !== false && (await isStreamServerUp(3000))) {
        rememberVpsDown(false)
        fallbackRef.current = false
        setFallback(false)
        reconnectAttemptsRef.current = 0
        fallbackItemIdRef.current = null
        setFallbackItem(null)
        reconnect()
        return
      }
      advanceFallback()
    }
    // A live stream "ending" is never intentional on the server side —
    // treat it exactly like a dropped connection.
    audio?.addEventListener('waiting', handleWaiting)
    audio?.addEventListener('stalled', handleWaiting)
    audio?.addEventListener('playing', handlePlaying)
    audio?.addEventListener('loadedmetadata', handleLoadedMetadata)
    audio?.addEventListener('seeked', handleSeeked)
    audio?.addEventListener('error', handleAudioError)
    audio?.addEventListener('ended', handleEnded)

    return () => {
      clearInterval(nowPlayingTimer)
      clearInterval(programTimer)
      stopProgramPush()
      clearInterval(backgroundTimer)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
      clearStreamWatchdog()
      audio?.removeEventListener('waiting', handleWaiting)
      audio?.removeEventListener('stalled', handleWaiting)
      audio?.removeEventListener('playing', handlePlaying)
      audio?.removeEventListener('loadedmetadata', handleLoadedMetadata)
      audio?.removeEventListener('seeked', handleSeeked)
      audio?.removeEventListener('error', handleAudioError)
      audio?.removeEventListener('ended', handleEnded)
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
      // An explicit pause cancels any in-flight reconnect attempt — a
      // drop-triggered retry landing a second after the user paused would
      // otherwise silently start the stream back up underneath them.
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
      clearStreamWatchdog()
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

    if (fallbackRef.current) {
      fallbackErrorsRef.current = 0
      if (!tuneInFallback()) {
        connectingRef.current = false
        setIsBuffering(false)
        setIsPaused(true)
        setConnectError(true)
      }
      return
    }

    // A live stream has no "resume from where I left off" — reconnecting
    // always joins wherever the broadcast currently is, exactly like tuning
    // in a real radio station. Reassigning `src` forces a fresh connection
    // rather than resuming a stale/stalled buffer from before a pause.
    armStreamWatchdog()
    playLive(audio)
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
    // Live radio: the lock screen gets no winding. A handler that does nothing
    // takes the place of the system's own seeking.
    const noWinding = ['seekto', 'seekforward', 'seekbackward', 'previoustrack', 'nexttrack'] as MediaSessionAction[]
    for (const action of noWinding) {
      try {
        navigator.mediaSession.setActionHandler(action, () => {})
      } catch {
        // not supported here
      }
    }
    return () => {
      for (const action of noWinding) {
        try {
          navigator.mediaSession.setActionHandler(action, null)
        } catch {
          // not supported here
        }
      }
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

  // What plays next comes from the radio server (it knows about the admin
  // queue). Asked again a little after every track change, once the server
  // has moved on, and once a minute in case an admin queued something.
  useEffect(() => {
    // Only a broadcast server knows its own queue; without one the plan has it.
    if (!LIVE_SERVER) return
    const refresh = () => fetchUpNextFilePath().then(setUpNextPath)
    const first = setTimeout(refresh, 12_000)
    const timer = setInterval(refresh, 60_000)
    return () => {
      clearTimeout(first)
      clearInterval(timer)
    }
  }, [nowPlaying?.title])

  // Matches Icecast's reported "artist - title" string back to a row in
  // our own playlist so the current track's real duration and what's next
  // in the (strictly sequential, never-shuffled) rotation can be shown —
  // Icecast itself only ever exposes the title text, never a position or
  // duration. Best-effort: if a track's ID3-derived title/artist doesn't
  // match the DB row closely enough, this just quietly shows nothing
  // rather than guessing wrong.
  const streamEntry = nowPlaying
    ? entries.find((e) => {
        const dbCombined = normalize(`${e.track.artist} - ${e.track.title}`)
        const liveCombined = normalize(`${nowPlaying.artist} - ${nowPlaying.title}`)
        return dbCombined === liveCombined || normalize(e.track.title) === normalize(nowPlaying.title)
      })
    : undefined
  const currentEntry = fallback && fallbackIndex >= 0 ? entries[fallbackIndex] : streamEntry
  const currentIndex = currentEntry ? entries.findIndex((e) => e.track.id === currentEntry.track.id) : -1

  // JINGLE 2 is deliberately NOT one of `entries` (it's not a numbered
  // rotation slot, see sync-playlist.sh on the VPS) — while it's actually
  // playing, nowPlaying never matches anything in entries and currentIndex
  // comes back -1, which used to blank out "next track" entirely for the
  // jingle's ~11 seconds. Remembering the last real match and falling
  // back to it keeps "next" pointing at whatever comes after the jingle
  // (the correct answer) instead of disappearing every third track.
  const lastKnownIndexRef = useRef(-1)
  if (currentIndex >= 0) lastKnownIndexRef.current = currentIndex
  const effectiveIndex = currentIndex >= 0 ? currentIndex : lastKnownIndexRef.current
  const playlistNextEntry =
    effectiveIndex >= 0 && entries.length > 0 ? entries[(effectiveIndex + 1) % entries.length] : undefined
  // The radio server's own answer wins: a track an admin queued plays before
  // the playlist continues. Ignored if it still names the current track (the
  // answer is cached for a few seconds and can lag a track change).
  const serverNextEntry = upNextPath ? entries.find((e) => e.track.filePath === upNextPath) : undefined
  const nextEntry = fallback
    ? playlistNextEntry
    : serverNextEntry && serverNextEntry.track.id !== currentEntry?.track.id ? serverNextEntry : playlistNextEntry

  // On the planned air "next" is simply the following item of the timeline
  // (or the one on right now, if this phone is still finishing the last one).
  const programItems = program?.items ?? []
  const fallbackItemIndex = fallbackItem ? programItems.findIndex((it) => it.id === fallbackItem.id) : -1
  const programNext = fallbackItem ? (fallbackItemIndex >= 0 ? programItems[fallbackItemIndex + 1] : programItems[0]) : undefined
  const nextTrack = fallback && fallbackItem ? programNext?.track : nextEntry?.track

  const isNewTrack =
    fallback && fallbackItem
      ? fallbackItem.isNew
      : !!currentEntry?.track.createdAt &&
        currentEntry.track.kind !== 'jingle' &&
        Date.now() - Date.parse(currentEntry.track.createdAt) < NEW_FOR_MS
  const airName = program?.slot?.label ?? program?.slot?.title
  // What a like goes to: the music track on air (not a jingle or an announcement).
  const likeTrackId =
    fallback && fallbackItem
      ? fallbackItem.kind === 'jingle' || fallbackItem.kind === 'timer'
        ? undefined
        : fallbackItem.track.id
      : currentEntry && currentEntry.track.kind !== 'jingle'
        ? currentEntry.track.id
        : undefined

  const showConnecting = userStarted && !isPaused && isBuffering

  return (
    <div className="bfm bfm-main">
      <header className="bfm__head">
        BIGUNDER FM
        <br />
        Independent Hip-Hop Radio
      </header>
      <div className="bfm__photo" style={background?.type === 'image' ? { backgroundImage: `url(${background.src})` } : undefined}>
        {background?.type === 'video' && (
          // Muted + playsInline + autoPlay is what lets mobile WebViews
          // (Telegram's included) autoplay a video at all.
          <video key={background.src} src={background.src} autoPlay loop muted playsInline aria-hidden="true" />
        )}
      </div>
      <div className="bfm__now">
        <span className="bfm__label">
          <span className="bfm__live" aria-hidden="true" />
          В эфире{airName ? ` · ${airName}` : ''}
          {isNewTrack ? ' · Новинка' : ''}
        </span>
        {/* One line each, shrunk to fit: the photo keeps its height whatever the names. */}
        <FitTitle className="bfm__artist" text={nowPlaying?.artist || '—'} min={18} />
        <FitTitle className="bfm__title" text={showConnecting ? 'Подключение...' : (nowPlaying?.title ?? 'Загрузка...')} min={12} />
      </div>
      <button type="button" className="bfm__play" onClick={handlePlayClick} disabled={userStarted && !isPaused && isBuffering}>
        <span>{userStarted && !isPaused ? 'Пауза' : 'Слушать'}</span>
        {userStarted && !isPaused ? <PauseIcon /> : <PlayIcon />}
      </button>
      <div className="bfm__actions">
        <LikeButton trackId={likeTrackId} />
        <button type="button" className="bfm__to-grid" onClick={onOpenGrid}>
          Сетка →
        </button>
      </div>
      <div className="bfm__next">
        <span className="bfm__next-tag">Дальше</span>
        <span className="bfm__next-name">{nextTrack ? `${nextTrack.artist} · ${nextTrack.title}` : ''}</span>
      </div>
      {connectError && <div className="bfm__error">Не удалось подключиться. Нажмите «Слушать» ещё раз.</div>}
      <Socials />
      <div hidden>
        <audio ref={audioRef} preload="none" />
      </div>
    </div>
  )
}
