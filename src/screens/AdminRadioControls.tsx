import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { fetchPlaylist, type PlaylistEntry } from '../lib/tracks'
import { fetchIcecastStatus, type IcecastStatus } from '../lib/radioServer'
import { formatDuration, formatElapsedSince } from '../lib/format'
import { useListenerCount } from '../lib/useListenerCount'

const STATUS_POLL_MS = 5000
// A single failed poll is routine (a request can just drop) — only flag
// the server as actually down after several polls in a row fail, so a
// one-off network blip doesn't flash a false alarm at the admin.
const FAILURES_BEFORE_WARNING = 3

// The broadcast is a real, always-on stream (Icecast + Liquidsoap on the
// VPS) — there's no "pause" concept anymore, same as a real radio station
// never pauses. The only server-side action left is Skip, which goes
// through the radio-skip Edge Function (admin-gated there via
// is_current_user_admin(), same check the old RPCs used) rather than a
// direct RPC, since the actual skip has to reach Liquidsoap's telnet
// control interface on the VPS, not the database.
export function AdminRadioControls() {
  const [entries, setEntries] = useState<PlaylistEntry[]>([])
  const [status, setStatus] = useState<IcecastStatus | null>(null)
  const [serverDown, setServerDown] = useState(false)
  const [skipping, setSkipping] = useState(false)
  const [skipError, setSkipError] = useState<string | null>(null)
  // "Открыли приложение" — presence-based, counts anyone with the app open
  // right now regardless of tab or whether they've pressed play. Distinct
  // from status.listeners (below), which is Icecast's own count of clients
  // actually receiving audio — the two numbers answering different
  // questions is exactly what today's whole "does it play or not" back-
  // and-forth needed visibility into.
  const appOpenCount = useListenerCount()
  const failureStreakRef = useRef(0)

  async function reloadPlaylist() {
    setEntries(await fetchPlaylist())
  }

  useEffect(() => {
    reloadPlaylist()

    async function poll() {
      const result = await fetchIcecastStatus()
      if (result) {
        failureStreakRef.current = 0
        setStatus(result)
        setServerDown(false)
      } else {
        failureStreakRef.current += 1
        if (failureStreakRef.current >= FAILURES_BEFORE_WARNING) {
          setServerDown(true)
        }
      }
    }
    poll()
    const timer = setInterval(poll, STATUS_POLL_MS)
    return () => clearInterval(timer)
  }, [])

  async function handleSkip() {
    setSkipping(true)
    setSkipError(null)
    try {
      const { data, error } = await supabase.functions.invoke('radio-skip', { method: 'POST' })
      if (error || data?.error) {
        setSkipError(data?.error ?? error?.message ?? 'Не удалось переключить трек')
      }
    } catch (err) {
      setSkipError((err as Error).message)
    } finally {
      setSkipping(false)
    }
  }

  const trackCount = entries.length
  const totalSeconds = entries.reduce((sum, e) => sum + e.track.durationSeconds, 0)

  return (
    <div className="admin-radio-controls">
      <h2>УПРАВЛЕНИЕ</h2>

      {serverDown && (
        <p className="admin-dashboard__warning">⚠ Сервер вещания не отвечает — эфир может быть прерван.</p>
      )}

      <div className="admin-dashboard__grid">
        <div className="admin-dashboard__tile">
          <span className="admin-dashboard__tile-value">{status?.listeners ?? '—'}</span>
          <span className="admin-dashboard__tile-label">Слушают поток</span>
        </div>
        <div className="admin-dashboard__tile">
          <span className="admin-dashboard__tile-value">{appOpenCount}</span>
          <span className="admin-dashboard__tile-label">Открыли приложение</span>
        </div>
        <div className="admin-dashboard__tile">
          <span className="admin-dashboard__tile-value">{status?.peakListeners ?? '—'}</span>
          <span className="admin-dashboard__tile-label">Пик слушателей</span>
        </div>
        <div className="admin-dashboard__tile">
          <span className="admin-dashboard__tile-value">
            {status?.streamStartedAt ? formatElapsedSince(status.streamStartedAt) : '—'}
          </span>
          <span className="admin-dashboard__tile-label">Эфир идёт</span>
        </div>
        <div className="admin-dashboard__tile">
          <span className="admin-dashboard__tile-value">{trackCount}</span>
          <span className="admin-dashboard__tile-label">Треков в ротации</span>
        </div>
        <div className="admin-dashboard__tile">
          <span className="admin-dashboard__tile-value">{formatDuration(totalSeconds)}</span>
          <span className="admin-dashboard__tile-label">Длительность ротации</span>
        </div>
        <div className="admin-dashboard__tile">
          <span className="admin-dashboard__tile-value">{status?.bitrateKbps ? `${status.bitrateKbps} kbps` : '—'}</span>
          <span className="admin-dashboard__tile-label">Битрейт</span>
        </div>
      </div>

      <div className="admin-dashboard__now-playing">
        <span className="admin-dashboard__now-playing-label">СЕЙЧАС ИГРАЕТ</span>
        <span className="admin-dashboard__now-playing-title">{status?.title ?? '—'}</span>
      </div>

      <button onClick={handleSkip} disabled={skipping}>
        {skipping ? 'ПЕРЕКЛЮЧАЮ...' : 'СЛЕДУЮЩИЙ ТРЕК'}
      </button>
      {skipError && <p className="admin-radio-controls__error">{skipError}</p>}

      <h3 className="admin-radio-controls__subheading">ПЛЕЙЛИСТ</h3>
      <ul>
        {entries.map((entry) => (
          <li key={entry.track.id}>
            <span className="admin-radio-controls__track-label">
              {entry.position}. {entry.track.artist} — {entry.track.title}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
