import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { fetchIcecastStatus, type IcecastStatus } from '../lib/radioServer'
import { fetchAdminStats, STORAGE_LIMIT_BYTES, type AdminStats } from '../lib/adminStats'
import { fetchShowName, updateShowName } from '../lib/showName'
import { fetchListeners, type Listener } from '../lib/listeners'
import { formatDuration, formatElapsedSince, formatBytes } from '../lib/format'

// Above this fraction of the free R2 allowance, flag it.
const STORAGE_WARNING_THRESHOLD = 0.85

const STATUS_POLL_MS = 5000
const LISTENERS_POLL_MS = 60_000
// A Telegram name has no length limit and no guaranteed spaces — a long
// one-word name (seen live: 64 repeated characters) still has to fit one
// line without ballooning the row, so it's clipped rather than wrapped.
const MAX_NAME_LENGTH = 28

function truncateName(name: string): string {
  return name.length > MAX_NAME_LENGTH ? `${name.slice(0, MAX_NAME_LENGTH)}…` : name
}
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
  const [skipping, setSkipping] = useState(false)
  const [skipError, setSkipError] = useState<string | null>(null)
  const failureStreakRef = useRef(0)
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [showNameInput, setShowNameInput] = useState('')
  const [savingShowName, setSavingShowName] = useState(false)
  const [showNameSaved, setShowNameSaved] = useState(false)
  const [showNameError, setShowNameError] = useState<string | null>(null)
  const [notifyText, setNotifyText] = useState('')
  const [notifying, setNotifying] = useState(false)
  const [notifyResult, setNotifyResult] = useState<string | null>(null)
  const [notifyError, setNotifyError] = useState<string | null>(null)
  const [listeners, setListeners] = useState<Listener[] | null>(null)
  // Briefly flags which row's copy button was just pressed, to show a
  // checkmark — the only feedback a clipboard write gets otherwise.
  const [copiedId, setCopiedId] = useState<number | null>(null)

  useEffect(() => {
    // Slow-changing numbers (peaks, storage): one fetch per visit.
    fetchAdminStats().then(setStats)
    fetchShowName().then(setShowNameInput)

    async function pollListeners() {
      const data = await fetchListeners()
      setListeners(data)
    }
    pollListeners()
    const listenersTimer = setInterval(pollListeners, LISTENERS_POLL_MS)

    async function pollStream() {
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
    pollStream()
    const streamTimer = setInterval(pollStream, STATUS_POLL_MS)
    return () => {
      clearInterval(streamTimer)
      clearInterval(listenersTimer)
    }
  }, [])

  async function handleSaveShowName() {
    setSavingShowName(true)
    setShowNameError(null)
    setShowNameSaved(false)
    const { error } = await updateShowName(showNameInput)
    if (error) {
      setShowNameError(error)
    } else {
      // Reflects back whatever was actually persisted (it trims and falls
      // back to the default for an empty input).
      setShowNameInput(await fetchShowName())
      setShowNameSaved(true)
    }
    setSavingShowName(false)
  }

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

  // Copies whatever identifier is actually useful for finding this person
  // in Telegram — @username if they have one (searchable, tappable
  // elsewhere), otherwise the raw numeric id as the only thing left to go
  // on. Never the display name alone: two different people can share one.
  async function handleCopyListener(l: Listener) {
    const value = l.username ? `@${l.username}` : String(l.telegramUserId)
    try {
      await navigator.clipboard.writeText(value)
      setCopiedId(l.telegramUserId)
      setTimeout(() => setCopiedId((id) => (id === l.telegramUserId ? null : id)), 1500)
    } catch {
      // Clipboard access can fail (old browser, denied permission) — no
      // real fallback beyond just not showing the "copied" confirmation.
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

      {serverDown && (
        <p className="admin-dashboard__warning">⚠ Сервер вещания не отвечает — эфир может быть прерван.</p>
      )}
      {storageLow && (
        <p className="admin-dashboard__warning">
          ⚠ Хранилище почти заполнено ({Math.round(storagePercent! * 100)}%) — бесплатный лимит Cloudflare R2 скоро
          закончится, загрузка новых треков может перестать работать.
        </p>
      )}

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
          <span className="admin-dashboard__tile-value">{status?.listeners ?? '—'}</span>
          <span className="admin-dashboard__tile-label">Слушают поток</span>
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
        <div className="admin-dashboard__tile">
          <span className="admin-dashboard__tile-value">
            {status?.streamStartedAt ? formatElapsedSince(status.streamStartedAt) : '—'}
          </span>
          <span className="admin-dashboard__tile-label">Эфир идёт</span>
        </div>
        <div className="admin-dashboard__tile">
          <span className="admin-dashboard__tile-value">{stats?.trackCount ?? '—'}</span>
          <span className="admin-dashboard__tile-label">Треков в ротации</span>
        </div>
        <div className="admin-dashboard__tile">
          <span className="admin-dashboard__tile-value">{stats ? formatDuration(stats.rotationSeconds) : '—'}</span>
          <span className="admin-dashboard__tile-label">Длительность ротации</span>
        </div>
        <div className="admin-dashboard__tile">
          <span className="admin-dashboard__tile-value">{status?.bitrateKbps ? `${status.bitrateKbps} kbps` : '—'}</span>
          <span className="admin-dashboard__tile-label">Битрейт</span>
        </div>
      </div>

      <div className="admin-dashboard__chart">
        <div className="admin-dashboard__chart-header">
          <span className="admin-dashboard__chart-label">СЛУШАТЕЛИ</span>
          <span className="admin-dashboard__chart-total">{listeners?.length ?? 0} всего</span>
        </div>
        <ul className="admin-listeners__box">
          {(listeners ?? []).map((l) => (
            <li key={l.telegramUserId} className="admin-listeners__row">
              {/* A live dot rather than re-sorting client-side — the list
                  already arrives sorted "listening now" first from the
                  server, this just makes that visible at a glance. */}
              {l.listeningNow && <span className="admin-listeners__live-dot" title="Слушает сейчас" />}
              <div className="admin-listeners__identity">
                <span className="admin-listeners__name" title={l.name ?? undefined}>
                  {/* Name if Telegram gave one; otherwise the username is
                      already a real identifier, only falling back to the
                      bare id when neither exists. The full name is still
                      on hover (title) — only the on-screen text is capped. */}
                  {l.name ? truncateName(l.name) : (l.username ? `@${l.username}` : `id ${l.telegramUserId}`)}
                  {l.isAdmin && <span className="admin-listeners__badge">админ</span>}
                </span>
                {/* Shown on its own line only when there's also a name
                    above it — otherwise it's already the line above. */}
                {l.name && l.username && <span className="admin-listeners__username">@{l.username}</span>}
              </div>
              <button
                type="button"
                className="admin-listeners__copy-button"
                onClick={() => handleCopyListener(l)}
                aria-label="Скопировать"
                title={l.username ? `@${l.username}` : String(l.telegramUserId)}
              >
                {copiedId === l.telegramUserId ? (
                  <span className="admin-listeners__copy-check">✓</span>
                ) : (
                  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="8" y="8" width="14" height="14" rx="4" ry="4" />
                    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
                  </svg>
                )}
              </button>
              <span className="admin-listeners__hours">{formatDuration(l.totalSeconds)}</span>
            </li>
          ))}
        </ul>
        <p className="admin-dashboard__chart-caption">
          {listeners !== null && listeners.length === 0
            ? 'Пока никто не заходил.'
            : 'Часы — реальное время со звуком, не просто открытое приложение. Отсортировано по убыванию.'}
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
        <span className="admin-dashboard__now-playing-title">{status?.title ?? '—'}</span>
      </div>

      <button onClick={handleSkip} disabled={skipping}>
        {skipping ? 'ПЕРЕКЛЮЧАЮ...' : 'СЛЕДУЮЩИЙ ТРЕК'}
      </button>
      {skipError && <p className="admin-radio-controls__error">{skipError}</p>}
    </div>
  )
}
