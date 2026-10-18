import { useEffect, useState } from 'react'
import { getLiveState, startLive, stopLive, subscribeLive, type LiveState } from '../lib/live'
import { formatDuration } from '../lib/format'

export function LiveBroadcast() {
  const [live, setLive] = useState<LiveState>(getLiveState())
  const [, setTick] = useState(0)

  useEffect(() => subscribeLive(setLive), [])

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

      <p className="admin-dashboard__show-name-status">
        Музыка затихает, пока вы говорите, и возвращается, когда эфир закончен. Слушатели слышат вас с задержкой
        5–10 секунд. Не слушайте радио на этом же телефоне без наушников — будет эхо. Не сворачивайте Telegram и не
        блокируйте экран, иначе эфир прервётся. Одновременно могут выйти до трёх человек.
      </p>
    </div>
  )
}
