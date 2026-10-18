import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { getLiveState, startLive, stopLive, subscribeLive, type LiveState } from '../lib/live'
import { formatDuration } from '../lib/format'

// The slider sends its value this long after the finger stops, not on every step.
const VOLUME_SEND_DELAY_MS = 300

export function LiveBroadcast() {
  const [live, setLive] = useState<LiveState>(getLiveState())
  const [, setTick] = useState(0)
  // Music level under the hosts' voices, 0..100 (%); null until loaded.
  const [musicVolume, setMusicVolume] = useState<number | null>(null)
  const [volumeError, setVolumeError] = useState<string | null>(null)
  const volumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => subscribeLive(setLive), [])

  useEffect(() => {
    api<{ value: number }>('/api/admin/music-volume')
      .then((r) => setMusicVolume(Math.round(r.value * 100)))
      .catch((err) => setVolumeError((err as Error).message))
    return () => {
      if (volumeTimerRef.current) clearTimeout(volumeTimerRef.current)
    }
  }, [])

  function handleVolumeChange(percent: number) {
    setMusicVolume(percent)
    if (volumeTimerRef.current) clearTimeout(volumeTimerRef.current)
    volumeTimerRef.current = setTimeout(async () => {
      try {
        await api('/api/admin/music-volume', { method: 'PUT', body: { value: percent / 100 } })
        setVolumeError(null)
      } catch (err) {
        setVolumeError((err as Error).message)
      }
    }, VOLUME_SEND_DELAY_MS)
  }

  useEffect(() => {
    if (live.phase !== 'live') return
    const timer = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(timer)
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
        </div>
      )}

      {isLive && (
        <div className="live-broadcast__meter" aria-hidden="true">
          <div className="live-broadcast__meter-fill" style={{ width: `${Math.round(live.level * 100)}%` }} />
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

      <label className="live-broadcast__volume">
        <span>
          Музыка под голосом: <b>{musicVolume === null ? '—' : `${musicVolume}%`}</b>
        </span>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={musicVolume ?? 20}
          disabled={musicVolume === null}
          onChange={(e) => handleVolumeChange(Number(e.target.value))}
        />
      </label>
      {volumeError && <p className="admin-radio-controls__error">{volumeError}</p>}

      <p className="admin-dashboard__show-name-status">
        Музыка затихает до громкости на ползунке, пока вы говорите (её можно менять прямо во время эфира; настройка общая для всех админов), и возвращается, когда эфир закончен. Слушатели слышат вас с задержкой
        5–10 секунд. Не слушайте радио на этом же телефоне без наушников — будет эхо. Не сворачивайте Telegram и не
        блокируйте экран, иначе эфир прервётся. Одновременно могут выйти до трёх человек.
      </p>
    </div>
  )
}
