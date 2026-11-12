import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { subscribeProgramChanged } from '../lib/presence'
import { LIVE_SERVER, fetchIcecastStatus, type IcecastStatus } from '../lib/radioServer'
import { fetchAdminStats, STORAGE_LIMIT_BYTES, type AdminStats } from '../lib/adminStats'
import { formatDuration, formatElapsedSince, formatBytes } from '../lib/format'
import { LiveBroadcast } from '../components/LiveBroadcast'
import { AdminAir } from './AdminAir'

// Above this fraction of the free R2 allowance, flag it.
const STORAGE_WARNING_THRESHOLD = 0.85

const STATUS_POLL_MS = 30_000
// A single failed poll is routine (a request can just drop) — only flag
// the server as actually down after several polls in a row fail, so a
// one-off network blip doesn't flash a false alarm at the admin.
const FAILURES_BEFORE_WARNING = 3

// The broadcast is a real, always-on stream (Icecast + Liquidsoap on the
// VPS) — there's no "pause" concept, same as a real radio station never
// pauses. The only server-side action is Skip, which the backend forwards to
// Liquidsoap's control interface on the VPS.
export function AdminRadioControls() {
  const [status, setStatus] = useState<IcecastStatus | null>(null)
  const [serverDown, setServerDown] = useState(false)
  // While the VPS is down the app plays from R2 (see RadioScreen); the
  // Worker reports what that fallback is playing and how many have the app open.
  const [fallbackStatus, setFallbackStatus] = useState<{ appOpen: number; title: string | null } | null>(null)
  const [skipping, setSkipping] = useState(false)
  const [skipError, setSkipError] = useState<string | null>(null)
  const failureStreakRef = useRef(0)
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [notifyText, setNotifyText] = useState('')
  const [notifying, setNotifying] = useState(false)
  const [notifyResult, setNotifyResult] = useState<string | null>(null)
  const [notifyError, setNotifyError] = useState<string | null>(null)

  useEffect(() => {
    // Slow-changing numbers (peaks, storage): one fetch per visit.
    fetchAdminStats().then(setStats)

    async function pollStream() {
      if (document.visibilityState !== 'visible') return
      const result = await fetchIcecastStatus()
      if (result) {
        failureStreakRef.current = 0
        setStatus(result)
        setServerDown(false)
        setFallbackStatus(null)
      } else {
        failureStreakRef.current += 1
        if (failureStreakRef.current >= FAILURES_BEFORE_WARNING) {
          setServerDown(true)
        }
        try {
          setFallbackStatus(await api<{ appOpen: number; title: string | null }>('/api/admin/fallback-status'))
          setStatus(null)
        } catch {
          // keep whatever was shown last
        }
      }
    }
    pollStream()
    const streamTimer = setInterval(pollStream, STATUS_POLL_MS)
    // A skip or a queue change shows up at once instead of at the next check.
    const stopPush = subscribeProgramChanged(pollStream)
    return () => {
      stopPush()
      clearInterval(streamTimer)
    }
  }, [])

  async function handleNotify() {
    const text = notifyText.trim()
    if (!text) return
    if (!window.confirm('Отправить это сообщение всем, кто открывал приложение? Отменить отправку нельзя.')) return
    setNotifying(true)
    setNotifyError(null)
    setNotifyResult(null)
    // The backend sends in chunks; keep asking until it says there is no next one.
    let offset = 0
    let sent = 0
    let failed = 0
    let total = 0
    try {
      for (;;) {
        const r = await api<{ sent: number; failed: number; total: number; next: number | null }>('/api/admin/notify', {
          method: 'POST',
          body: { text, offset, totals: { sent, failed } },
        })
        sent += r.sent
        failed += r.failed
        total = r.total
        if (r.next === null) break
        setNotifyResult(`Отправляю… ${sent + failed} из ${total}`)
        offset = r.next
      }
      setNotifyResult(`Отправлено: ${sent} из ${total}${failed ? ` (не доставлено: ${failed})` : ''}`)
      setNotifyText('')
    } catch (err) {
      setNotifyError(`${(err as Error).message} (успело уйти: ${sent})`)
    } finally {
      setNotifying(false)
    }
  }

  async function handleSkip() {
    setSkipping(true)
    setSkipError(null)
    try {
      await api('/api/admin/skip', { method: 'POST' })
    } catch (err) {
      setSkipError((err as Error).message || 'Не удалось переключить трек')
    } finally {
      setSkipping(false)
    }
  }

  const storagePercent = stats ? stats.storageUsedBytes / STORAGE_LIMIT_BYTES : null
  const storageLow = storagePercent !== null && storagePercent >= STORAGE_WARNING_THRESHOLD

  return (
    <div className="admin-radio-controls">
      <h2>УПРАВЛЕНИЕ</h2>

      {LIVE_SERVER && serverDown && (
        <p className="admin-dashboard__warning">
          Сервер вещания не отвечает. Радио играет прямо из Cloudflare по той же авторотации: музыка идёт, треки
          переключаются, но выход ведущих в эфир с микрофоном сейчас не работает.
        </p>
      )}
      {storageLow && (
        <p className="admin-dashboard__warning">
          ⚠ Хранилище почти заполнено ({Math.round(storagePercent! * 100)}%) — бесплатный лимит Cloudflare R2 скоро
          закончится, загрузка новых треков может перестать работать.
        </p>
      )}

      {LIVE_SERVER && <LiveBroadcast />}

      <div className="admin-dashboard__storage">
        <div className="admin-dashboard__storage-row">
          <span className="admin-dashboard__storage-label">Хранилище (бесплатный лимит)</span>
          <span className="admin-dashboard__storage-value">
            {stats ? `${formatBytes(stats.storageUsedBytes)} / ${formatBytes(STORAGE_LIMIT_BYTES)}` : '—'}
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
          <span className="admin-dashboard__tile-value">{status?.listeners ?? fallbackStatus?.appOpen ?? '—'}</span>
          <span className="admin-dashboard__tile-label">{status ? 'Слушают поток' : fallbackStatus ? 'Открыли приложение' : 'Слушают поток'}</span>
        </div>
        <div className="admin-dashboard__tile">
          <span className="admin-dashboard__tile-value">{stats?.peaks.day ?? '—'}</span>
          <span className="admin-dashboard__tile-label">Пик за день</span>
        </div>
        <div className="admin-dashboard__tile">
          <span className="admin-dashboard__tile-value">{stats?.peaks.week ?? '—'}</span>
          <span className="admin-dashboard__tile-label">Пик за неделю</span>
        </div>
        <div className="admin-dashboard__tile">
          <span className="admin-dashboard__tile-value">{stats?.peaks.month ?? '—'}</span>
          <span className="admin-dashboard__tile-label">Пик за месяц</span>
        </div>
        {LIVE_SERVER && (
        <div className="admin-dashboard__tile">
          <span className="admin-dashboard__tile-value">
            {status?.streamStartedAt ? formatElapsedSince(status.streamStartedAt) : '—'}
          </span>
          <span className="admin-dashboard__tile-label">Эфир идёт</span>
        </div>
        )}
        <div className="admin-dashboard__tile">
          <span className="admin-dashboard__tile-value">{stats?.trackCount ?? '—'}</span>
          <span className="admin-dashboard__tile-label">Треков в ротации</span>
        </div>
        <div className="admin-dashboard__tile">
          <span className="admin-dashboard__tile-value">{stats ? formatDuration(stats.rotationSeconds) : '—'}</span>
          <span className="admin-dashboard__tile-label">Длительность ротации</span>
        </div>
        {LIVE_SERVER && (
        <div className="admin-dashboard__tile">
          <span className="admin-dashboard__tile-value">{status?.bitrateKbps ? `${status.bitrateKbps} kbps` : '—'}</span>
          <span className="admin-dashboard__tile-label">Битрейт</span>
        </div>
        )}
      </div>

      <AdminAir />

      <div className="admin-dashboard__show-name">
        <label htmlFor="admin-notify-input" className="admin-dashboard__show-name-label">
          УВЕДОМЛЕНИЕ В БОТЕ
        </label>
        <textarea
          id="admin-notify-input"
          className="admin-dashboard__notify-input"
          value={notifyText}
          onChange={(e) => {
            setNotifyText(e.target.value)
            setNotifyResult(null)
          }}
          placeholder="Текст сообщения для слушателей"
          maxLength={1000}
          rows={4}
        />
        <button onClick={handleNotify} disabled={notifying || !notifyText.trim()}>
          {notifying ? 'ОТПРАВЛЯЮ...' : 'ОТПРАВИТЬ ВСЕМ'}
        </button>
        {notifyResult && <p className="admin-dashboard__show-name-status">{notifyResult}</p>}
        {notifyError && <p className="admin-radio-controls__error">{notifyError}</p>}
      </div>

      <div className="admin-dashboard__now-playing">
        <span className="admin-dashboard__now-playing-label">СЕЙЧАС ИГРАЕТ</span>
        <span className="admin-dashboard__now-playing-title">{status?.title ?? fallbackStatus?.title ?? '—'}</span>
      </div>

      <button onClick={handleSkip} disabled={skipping}>
        {skipping ? 'ПЕРЕКЛЮЧАЮ...' : 'СЛЕДУЮЩИЙ ТРЕК'}
      </button>
      {skipError && <p className="admin-radio-controls__error">{skipError}</p>}
    </div>
  )
}
