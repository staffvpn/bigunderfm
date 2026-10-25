import { useEffect, useState } from 'react'
import { fetchEvents, type EventItem } from '../lib/events'

const POLL_MS = 60 * 60_000

const weekday = (d: Date) => d.toLocaleDateString('ru-RU', { weekday: 'short' }).toUpperCase().replace('.', '')
const dayMonth = (d: Date) => `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`
const time = (d: Date) => d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })

/** The nearest upcoming show under the Live cover, as one row of the
    schedule list (bigunder.ru style): in ink when it is today, pale
    otherwise. Renders nothing when there are no upcoming events. */
export function NextShowCard() {
  const [next, setNext] = useState<EventItem | null>(null)

  useEffect(() => {
    let cancelled = false

    async function check() {
      const events = await fetchEvents()
      if (cancelled) return
      setNext(events.find((e) => new Date(e.eventAt).getTime() >= Date.now()) ?? null)
    }

    check()
    const timer = setInterval(check, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  if (!next) return null

  const when = new Date(next.eventAt)
  const isToday = when.toDateString() === new Date().toDateString()

  return (
    <div className={`slist__row next-show${isToday ? ' is-today' : ''}`}>
      <div className="slist__line">
        <span className="slist__d">
          {isToday ? 'СЕГОДНЯ' : `${weekday(when)} ${dayMonth(when)}`}
          <br />
          {time(when)}
        </span>
        <span className="slist__n">{next.title}</span>
      </div>
    </div>
  )
}
