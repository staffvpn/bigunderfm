import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { fetchPlaylist, type PlaylistEntry } from '../lib/tracks'
import { fetchIcecastStatus, type IcecastStatus } from '../lib/radioServer'
import { fetchStorageUsage, type StorageUsage } from '../lib/storageUsage'
import { fetchShowName, updateShowName } from '../lib/showName'
import { fetchHourlyOpens, type HourlyOpens } from '../lib/loginEvents'
import { formatDuration, formatElapsedSince, formatBytes } from '../lib/format'
import { useListenerCount } from '../lib/useListenerCount'

// Above this fraction of the free plan's 1 GB Storage cap, flag it —
// uploads will start hard-failing once the limit is actually hit, so this
// needs to be visible well before that, not discovered as an upload error.
const STORAGE_WARNING_THRESHOLD = 0.85

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
  const [storageUsage, setStorageUsage] = useState<StorageUsage | null>(null)
  const [showNameInput, setShowNameInput] = useState('')
  const [savingShowName, setSavingShowName] = useState(false)
  const [showNameSaved, setShowNameSaved] = useState(false)
  const [showNameError, setShowNameError] = useState<string | null>(null)
  const [hourlyOpens, setHourlyOpens] = useState<HourlyOpens[] | null>(null)

  async function reloadPlaylist() {
    setEntries(await fetchPlaylist())
  }

  useEffect(() => {
    reloadPlaylist()
    // Storage usage doesn't change second-to-second like the rest of this
    // dashboard — one fetch per visit to the tab is enough, not worth
    // polling on the same 5s clock as the live stream stats.
    fetchStorageUsage().then(setStorageUsage)
    fetchShowName().then(setShowNameInput)
    // Same one-fetch-per-visit treatment as storage usage — this is a
    // slow-changing histogram over historical data, not a live stat.
    fetchHourlyOpens().then(setHourlyOpens)

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

  async function handleSaveShowName() {
    setSavingShowName(true)
    setShowNameError(null)
    setShowNameSaved(false)
    const { error } = await updateShowName(showNameInput)
    if (error) {
      setShowNameError(error)
    } else {
      // Reflects back whatever updateShowName actually persisted (it
      // trims and falls back to the default for an empty/whitespace
      // input) — otherwise the field could show blank/untrimmed text
      // that no longer matches what listeners are seeing.
      setShowNameInput(await fetchShowName())
      setShowNameSaved(true)
    }
    setSavingShowName(false)
  }

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
  const storagePercent = storageUsage ? storageUsage.usedBytes / storageUsage.limitBytes : null
  const storageLow = storagePercent !== null && storagePercent >= STORAGE_WARNING_THRESHOLD
  const maxHourlyOpens = hourlyOpens ? Math.max(1, ...hourlyOpens.map((h) => h.count)) : 1
  const totalOpens = hourlyOpens ? hourlyOpens.reduce((sum, h) => sum + h.count, 0) : 0

  return (
    <div className="admin-radio-controls">
      <h2>УПРАВЛЕНИЕ</h2>

      {serverDown && (
        <p className="admin-dashboard__warning">⚠ Сервер вещания не отвечает — эфир может быть прерван.</p>
      )}
      {storageLow && (
        <p className="admin-dashboard__warning">
          ⚠ Хранилище почти заполнено ({Math.round(storagePercent! * 100)}%) — скоро понадобится платный тариф
          Supabase, иначе загрузка новых треков перестанет работать.
        </p>
      )}

      <div className="admin-dashboard__storage">
        <div className="admin-dashboard__storage-row">
          <span className="admin-dashboard__storage-label">Хранилище (бесплатный лимит)</span>
          <span className="admin-dashboard__storage-value">
            {storageUsage ? `${formatBytes(storageUsage.usedBytes)} / ${formatBytes(storageUsage.limitBytes)}` : '—'}
          </span>
        </div>
        <div className="admin-dashboard__storage-bar">
          <div
            className={`admin-dashboard__storage-bar-fill${storageLow ? ' admin-dashboard__storage-bar-fill--warning' : ''}`}
            style={{ width: `${storagePercent !== null ? Math.min(100, storagePercent * 100) : 0}%` }}
          />
        </div>
      </div>

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

      <div className="admin-dashboard__chart">
        <div className="admin-dashboard__chart-header">
          <span className="admin-dashboard__chart-label">КОГДА ОТКРЫВАЮТ ПРИЛОЖЕНИЕ</span>
          <span className="admin-dashboard__chart-total">{totalOpens} заходов всего</span>
        </div>
        <div className="admin-dashboard__chart-bars">
          {(hourlyOpens ?? []).map(({ hour, count }) => (
            <div key={hour} className="admin-dashboard__chart-bar-wrap" title={`${hour}:00 — ${count}`}>
              <div
                className="admin-dashboard__chart-bar"
                style={{ height: `${(count / maxHourlyOpens) * 100}%` }}
              />
            </div>
          ))}
        </div>
        <div className="admin-dashboard__chart-ticks">
          {(hourlyOpens ?? []).map(({ hour }) => (
            <span key={hour} className="admin-dashboard__chart-tick">
              {hour % 3 === 0 ? hour : ''}
            </span>
          ))}
        </div>
        <p className="admin-dashboard__chart-caption">
          По часам суток (твоё местное время), за всё время работы приложения.
        </p>
      </div>

      <div className="admin-dashboard__show-name">
        <label htmlFor="admin-show-name-input" className="admin-dashboard__show-name-label">
          НАЗВАНИЕ ШОУ
        </label>
        <div className="admin-dashboard__show-name-row">
          <input
            id="admin-show-name-input"
            type="text"
            value={showNameInput}
            onChange={(e) => {
              setShowNameInput(e.target.value)
              setShowNameSaved(false)
            }}
            placeholder="LOCAL SELECTS"
            maxLength={60}
          />
          <button onClick={handleSaveShowName} disabled={savingShowName}>
            {savingShowName ? 'СОХРАНЯЮ...' : 'СОХРАНИТЬ'}
          </button>
        </div>
        {showNameSaved && <p className="admin-dashboard__show-name-status">Сохранено — уже видно в эфире.</p>}
        {showNameError && <p className="admin-radio-controls__error">{showNameError}</p>}
      </div>

      <div className="admin-dashboard__now-playing">
        <span className="admin-dashboard__now-playing-label">СЕЙЧАС ИГРАЕТ</span>
        <span className="admin-dashboard__now-playing-title">{status?.title ?? '—'}</span>
      </div>

      <button onClick={handleSkip} disabled={skipping}>
        {skipping ? 'ПЕРЕКЛЮЧАЮ...' : 'СЛЕДУЮЩИЙ ТРЕК'}
      </button>
      {skipError && <p className="admin-radio-controls__error">{skipError}</p>}
    </div>
  )
}
