import { useEffect, useState } from 'react'

// The quarter of an hour before a show: the "next" row quietly turns into a
// countdown, and a thin blue line fills along its bottom edge.
const WINDOW_MS = 15 * 60_000

export function ShowCountdown({ title, startsAt, clockOffsetMs = 0, fallback }: { title: string; startsAt: string; clockOffsetMs?: number; fallback: React.ReactNode }) {
  const [now, setNow] = useState(() => Date.now() + clockOffsetMs)
  const start = Date.parse(startsAt)
  const left = start - now
  const active = left > -60_000 && left <= WINDOW_MS

  useEffect(() => {
    // Ticks every second only inside the window; outside it, once a minute.
    const timer = setInterval(() => setNow(Date.now() + clockOffsetMs), active ? 1000 : 30_000)
    return () => clearInterval(timer)
  }, [active, clockOffsetMs])

  if (!active) return <>{fallback}</>
  const s = Math.max(0, Math.ceil(left / 1000))
  const mm = String(Math.floor(s / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  const at = new Date(start).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' })
  const progress = Math.min(1, Math.max(0, 1 - left / WINDOW_MS))
  return (
    <div className="bfm__next bfm__countdown" aria-live="off">
      <span className="bfm__next-tag">{at}</span>
      <span className="bfm__next-name">{title}</span>
      <span className="bfm__countdown-time">{s > 0 ? `через ${mm}:${ss}` : 'начинается'}</span>
      <span className="bfm__countdown-line" style={{ transform: `scaleX(${progress})` }} />
    </div>
  )
}
