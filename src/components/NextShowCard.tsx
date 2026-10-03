import { useEffect, useState } from 'react'
import { fetchEvents, type EventItem } from '../lib/events'
import { formatEventDateTime } from '../lib/format'

const POLL_MS = 60_000

/** Card under the Live cover showing the nearest upcoming show. Renders
    nothing when there are no upcoming events. */
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

  return (
    <div className="next-show">
      {next.imageUrl && <img src={next.imageUrl} alt="" className="next-show__image" />}
      <div className="next-show__body">
        <span className="next-show__datetime">{formatEventDateTime(next.eventAt)}</span>
        <span className="next-show__title">{next.title}</span>
        {next.description && <span className="next-show__description">{next.description}</span>}
      </div>
    </div>
  )
}
