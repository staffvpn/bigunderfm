import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { fetchPlaylist, type PlaylistEntry } from '../lib/tracks'
import { OnAirBadge } from '../components/OnAirBadge'
import { Equalizer } from '../components/Equalizer'
import { useAudioAnalyser } from '../lib/useAudioAnalyser'

// Real, always-on broadcast — Icecast (distribution) + Liquidsoap
// (scheduling/encoding) running on a dedicated VPS, streaming the shared
// playlist continuously. Every listener just connects to this URL and
// plays it; there is no seeking, no per-client position math, and no
// virtual timeline to fall out of sync with. This replaces the previous
// "virtual synced timeline" design (client-side seek against a shared
// anchor timestamp), which never reliably seeked on iOS/WebKit — a live
// stream structurally can't have that bug, there is nothing to seek.
// HTTPS via nginx + Let's Encrypt on the VPS, fronting Icecast — plain
// http:// here was silently blocked as mixed content by the browser
// since the app itself is served over https://, which looked like
// "nothing works" with no visible error. sslip.io is a free wildcard DNS
// that resolves <ip-with-dashes>.sslip.io back to that literal IP, which
// is enough for Let's Encrypt's HTTP-01 challenge — no real domain needed.
const STREAM_HOST = 'https://159-194-234-135.sslip.io'
const STREAM_URL = `${STREAM_HOST}/radio`

// Icecast's status-json.xsl escapes non-ASCII in the title as numeric HTML
// entities (e.g. "Б" -> "&#1041;") — that's XML-safe encoding, not actual
// HTML, so it comes through as literal "&#1041;" text rather than being
// decoded automatically. Routing it through the browser's own HTML parser
// (never inserted into the live DOM) decodes it correctly for any entity,
// not just the numeric ones Icecast happens to use today.
function decodeHtmlEntities(text: string): string {
  const el = document.createElement('textarea')
  el.innerHTML = text
  return el.value
}

export function RadioScreen() {
  const [entries, setEntries] = useState<PlaylistEntry[]>([])
  const [userStarted, setUserStarted] = useState(false)
  const [isPaused, setIsPaused] = useState(true)
  // Connecting to a live stream isn't instant (DNS + TLS + TCP + enough
  // buffered audio to actually start, ~1-2s) — without this the button
  // flips to the pause icon the instant it's clicked while nothing is
  // audible yet, which reads as "stuck"/"not working" rather than "loading".
  const [isBuffering, setIsBuffering] = useState(false)
  const [nowPlaying, setNowPlaying] = useState<{ artist: string; title: string } | null>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const { analyser, resume: resumeAnalyser } = useAudioAnalyser(audioRef)

  // Playlist is fetched purely for display (art/next-up etc. if ever
  // needed) — it no longer drives playback at all, so edits in the admin
  // library can be shown immediately without touching what's audible.
  async function refreshEntries() {
    setEntries(await fetchPlaylist())
  }

  useEffect(() => {
    refreshEntries()

    const channel = supabase
      .channel('radio-room')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'playlist_items' }, refreshEntries)
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await channel.track({ joined_at: new Date().toISOString() })
        }
      })

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
    function handleWaiting() {
      setIsBuffering(true)
    }
    function handlePlaying() {
      setIsBuffering(false)
    }
    function handleAudioError() {
      setIsBuffering(false)
      setIsPaused(true)
    }
    audio?.addEventListener('waiting', handleWaiting)
    audio?.addEventListener('stalled', handleWaiting)
    audio?.addEventListener('playing', handlePlaying)
    audio?.addEventListener('error', handleAudioError)

    return () => {
      supabase.removeChannel(channel)
      clearInterval(nowPlayingTimer)
      audio?.removeEventListener('waiting', handleWaiting)
      audio?.removeEventListener('stalled', handleWaiting)
      audio?.removeEventListener('playing', handlePlaying)
      audio?.removeEventListener('error', handleAudioError)
      audio?.pause()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Shared by the play button AND Media Session action handlers below.
  function setPlaybackIntent(playing: boolean) {
    const audio = audioRef.current
    if (!audio) return

    // Must run synchronously inside the originating user-gesture call
    // stack — Safari/iOS only resumes a suspended AudioContext (and
    // permits audio.play()) from within one.
    resumeAnalyser()

    setUserStarted(true)
    setIsPaused(!playing)

    if (!playing) {
      setIsBuffering(false)
      audio.pause()
      return
    }

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

  const nextEntry = entries.length > 0 ? entries[0] : undefined

  return (
    <div className="radio-screen">
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

      <Equalizer analyser={analyser} />

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

      {nextEntry && (
        <div className="radio-screen__next">
          В ЭФИРЕ 24/7 • {entries.length} треков в ротации
        </div>
      )}

      <audio ref={audioRef} crossOrigin="anonymous" preload="none" />
    </div>
  )
}
