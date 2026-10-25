import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { getLiveState, startLive, stopLive, subscribeLive, type LiveState } from '../lib/live'
import { getCallState, resumeCallAudio, subscribeCall, type CallState } from '../lib/hostCall'
import { formatDuration } from '../lib/format'
import { subscribeHearts } from '../lib/presence'

// The slider sends its value this long after the finger stops, not on every step.
const LEVEL_SEND_DELAY_MS = 300

/** A level stored on the radio server (shared by all admins), shown in %. */
function LevelSlider(props: { label: string; endpoint: string; min: number; max: number; step: number; fallback: number }) {
  const { label, endpoint, min, max, step, fallback } = props
  const [percent, setPercent] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    api<{ value: number }>(endpoint)
      .then((r) => setPercent(Math.round(r.value * 100)))
      .catch((err) => setError((err as Error).message))
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [endpoint])

  function handleChange(next: number) {
    setPercent(next)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(async () => {
      try {
        await api(endpoint, { method: 'PUT', body: { value: next / 100 } })
        setError(null)
      } catch (err) {
        setError((err as Error).message)
      }
    }, LEVEL_SEND_DELAY_MS)
  }

  return (
    <>
      <label className="live-broadcast__volume">
        <span>
          {label}: <b>{percent === null ? '—' : `${percent}%`}</b>
        </span>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={percent ?? fallback}
          disabled={percent === null}
          onChange={(e) => handleChange(Number(e.target.value))}
        />
      </label>
      {error && <p className="admin-radio-controls__error">{error}</p>}
    </>
  )
}

const PEER_STATE_LABEL: Record<string, string> = {
  connecting: 'соединяю…',
  connected: 'на связи',
  failed: 'нет связи',
}

export function LiveBroadcast() {
  const [live, setLive] = useState<LiveState>(getLiveState())
  const [call, setCall] = useState<CallState>(getCallState())
  const [, setTick] = useState(0)
  // Hearts listeners sent since this host went live.
  const [hearts, setHearts] = useState(0)

  useEffect(() => subscribeLive(setLive), [])
  useEffect(() => subscribeCall(setCall), [])

  useEffect(() => {
    if (live.phase !== 'live') return
    const timer = setInterval(() => setTick((t) => t + 1), 1000)
    setHearts(0)
    const unsubscribe = subscribeHearts((n) => setHearts((h) => h + n))
    return () => {
      clearInterval(timer)
      unsubscribe()
    }
  }, [live.phase])

  const isLive = live.phase === 'live'
  const elapsed = isLive && live.startedAt ? formatDuration((Date.now() - live.startedAt) / 1000) : null

  return (
    <div className={`admin-dashboard__show-name live-broadcast${isLive ? ' is-live' : ''}`}>
      <span className="admin-dashboard__show-name-label">ЖИВОЙ ЭФИР</span>

      {isLive && (
        <div className="live-broadcast__status">
          <span className="live-broadcast__dot" />
          ВЫ В ЭФИРЕ {elapsed}
          <span className="live-broadcast__hearts">♥ {hearts}</span>
        </div>
      )}

      {isLive && (
        <div className="live-broadcast__meter" aria-hidden="true">
          <div className="live-broadcast__meter-fill" style={{ width: `${Math.round(live.level * 100)}%` }} />
        </div>
      )}

      {isLive && (
        <div className="live-broadcast__call">
          {call.peers.map((p) => (
            <span key={p.id} className={`live-broadcast__peer is-${p.state}`}>
              {p.name} — {PEER_STATE_LABEL[p.state]}
            </span>
          ))}
          {call.needsTap && <button onClick={resumeCallAudio}>ВКЛЮЧИТЬ ЗВУК ВЕДУЩИХ</button>}
        </div>
      )}

      {isLive ? (
        <button onClick={stopLive}>ЗАКОНЧИТЬ ЭФИР</button>
      ) : (
        <button onClick={startLive} disabled={live.phase === 'starting'}>
          {live.phase === 'starting' ? 'ПОДКЛЮЧАЮ...' : 'ВЫЙТИ В ЭФИР'}
        </button>
      )}

      {live.error && <p className="admin-radio-controls__error">{live.error}</p>}

      <LevelSlider label="Громкость голосов" endpoint="/api/admin/voice-gain" min={50} max={600} step={10} fallback={250} />
      <LevelSlider label="Музыка под голосом" endpoint="/api/admin/music-volume" min={0} max={100} step={5} fallback={20} />
    </div>
  )
}
