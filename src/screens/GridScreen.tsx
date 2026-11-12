import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { deviceId, sendLike } from '../lib/likes'
import { currentBackgroundImage } from '../lib/backgrounds'
import { subscribeProgramChanged } from '../lib/presence'
import { HeartIcon } from '../components/Icons'
import { Socials } from '../components/Socials'

// The air as a table: what just played (a like can still be given), what is
// on, what is next, and when the shows air. One request per visit, then one
// more each time the track changes.

interface GridTrack {
  trackId: string
  startsAt: string
  artist: string
  title: string
  likes: number
  liked: boolean
}
interface Grid {
  now: string
  slot: string | null
  current: (Omit<GridTrack, 'trackId'> & { trackId: string | null; endsAt: string; isNew: boolean }) | null
  next: { startsAt: string; artist: string; title: string } | null
  past: GridTrack[]
  shows: { title: string; days: string; startMinute: number }[]
}

const MSK = 'Europe/Moscow'
const clock = (iso: string | number) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: MSK })
const DAYS = ['ПН', 'ВТ', 'СР', 'ЧТ', 'ПТ', 'СБ', 'ВС']
const showDays = (days: string) => (days.length >= 7 ? 'ЕЖЕДН.' : [...days].map((d) => DAYS[Number(d) - 1] ?? '').join(' '))
const showTime = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`

export function GridScreen({ onBack }: { onBack: () => void }) {
  const [grid, setGrid] = useState<Grid | null>(null)
  const [failed, setFailed] = useState(false)
  const [nowLabel, setNowLabel] = useState('')
  const [photo] = useState(() => currentBackgroundImage())
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let alive = true
    async function load() {
      try {
        const data = await api<Grid>(`/api/grid?device=${encodeURIComponent(deviceId())}`)
        if (!alive) return
        setGrid(data)
        setFailed(false)
        // Again shortly after the track on air ends (never more often than every 20 s).
        const wait = data.current ? Date.parse(data.current.endsAt) - Date.parse(data.now) + 2000 : 60_000
        if (timerRef.current) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(load, Math.max(20_000, Math.min(wait, 10 * 60_000)))
      } catch {
        if (alive) setFailed(true)
      }
    }
    load()
    const stopPush = subscribeProgramChanged(load)
    const tick = () =>
      setNowLabel(
        `${new Date().toLocaleDateString('ru-RU', { timeZone: MSK })}, ${clock(Date.now())}, МСК`,
      )
    tick()
    const clockTimer = setInterval(tick, 20_000)
    return () => {
      alive = false
      stopPush()
      clearInterval(clockTimer)
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  function like(trackId: string) {
    setGrid((g) => {
      if (!g) return g
      const bump = <T extends { trackId: string | null; likes: number; liked: boolean }>(t: T): T =>
        t.trackId === trackId && !t.liked ? { ...t, likes: t.likes + 1, liked: true } : t
      return { ...g, past: g.past.map(bump), current: g.current ? bump(g.current) : null }
    })
    navigator.vibrate?.(8)
    sendLike(trackId).catch(() => {})
  }

  const likeCell = (t: { trackId: string | null; likes: number; liked: boolean }) =>
    t.trackId ? (
      <button
        type="button"
        className={`bfm-grid__like${t.liked ? ' is-liked' : ''}`}
        onClick={() => !t.liked && like(t.trackId!)}
        aria-label={t.liked ? 'Лайк уже стоит' : 'Поставить лайк'}
      >
        <span>{t.likes > 0 ? t.likes : ''}</span>
        <HeartIcon filled={t.liked} size={16} />
      </button>
    ) : (
      <span className="bfm-grid__like" />
    )

  const current = grid?.current

  return (
    <div className="bfm bfm-grid">
      <header className="bfm__head">
        BIGUNDER FM
        <br />
        Independent Hip-Hop Radio
      </header>
      <div className="bfm-grid__bar">
        <button type="button" className="bfm-grid__back" onClick={onBack}>
          ← Эфир
        </button>
        <span>{nowLabel}</span>
        <span className="bfm-grid__tab">Сетка</span>
      </div>
      <div className="bfm-grid__cols">
        <span className="bfm-grid__time">Время</span>
        <span className="bfm-grid__artist">Артист</span>
        <span className="bfm-grid__track">Трек</span>
        <span>{grid?.slot ?? ''}</span>
      </div>
      {!grid && <div className="bfm-grid__row">{failed ? 'Не удалось загрузить. Попробуйте позже.' : 'Загрузка...'}</div>}
      {grid?.past.map((t) => (
        <div className="bfm-grid__row" key={t.startsAt}>
          <span className="bfm-grid__time">{clock(t.startsAt)}</span>
          <span className="bfm-grid__artist">{t.artist}</span>
          <span className="bfm-grid__track">{t.title}</span>
          {likeCell(t)}
        </div>
      ))}
      {current && (
        <>
          <div className="bfm-grid__row is-current">
            <span className="bfm-grid__time">{clock(current.startsAt)}</span>
            <span className="bfm-grid__artist">{current.artist}</span>
            <span className="bfm-grid__track">{current.title}</span>
            {likeCell(current)}
          </div>
          <div className="bfm-grid__now">
            <div className="bfm-grid__photo" style={photo ? { backgroundImage: `url(${photo})` } : undefined} />
            <div className="bfm-grid__card">
              <span className="bfm__label">Сейчас в эфире</span>
              <span className="bfm-grid__card-artist">{current.artist}</span>
              <span className="bfm-grid__card-title">{current.title}</span>
              <span className="bfm-grid__card-meta">
                {[current.isNew ? 'Новинка' : '', current.trackId ? `Лайков: ${current.likes}` : ''].filter(Boolean).join(' · ')}
              </span>
            </div>
          </div>
        </>
      )}
      {grid?.next && (
        <div className="bfm-grid__row">
          <span className="bfm-grid__time">{clock(grid.next.startsAt)}</span>
          <span className="bfm-grid__artist">{grid.next.artist}</span>
          <span className="bfm-grid__track">{grid.next.title}</span>
          <span>Дальше</span>
        </div>
      )}
      {grid && grid.shows.length > 0 && (
        <>
          <div className="bfm-grid__cols">
            <span className="bfm-grid__track">Шоу</span>
          </div>
          {grid.shows.map((s) => (
            <div className="bfm-grid__row" key={s.title + s.days}>
              <span className="bfm-grid__showtime">
                {showDays(s.days)} {showTime(s.startMinute)}
              </span>
              <span className="bfm-grid__track">{s.title}</span>
            </div>
          ))}
        </>
      )}
      <Socials />
    </div>
  )
}
