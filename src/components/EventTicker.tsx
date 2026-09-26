import { useEffect, useState } from 'react'
import { fetchEvents } from '../lib/events'
import { formatEventDateTime } from '../lib/format'

// How far ahead of an event's start the "coming soon" banner shows on the
// Live screen. Change this one constant to adjust the window.
const SOON_WINDOW_MS = 24 * 60 * 60 * 1000
const POLL_MS = 60_000

/** Scrolling banner at the top of the Live screen, shown only while the
    nearest upcoming event (see lib/events.ts — already sorted soonest
    first, past events excluded) is within SOON_WINDOW_MS of starting. */
export function EventTicker() {
  const [text, setText] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function check() {
      const events = await fetchEvents()
      if (cancelled) return
      const next = events[0]
      const soon = next && new Date(next.eventAt).getTime() - Date.now() <= SOON_WINDOW_MS
      setText(soon ? `СКОРО: ${next.title} — ${formatEventDateTime(next.eventAt)}` : null)
    }

    check()
    const timer = setInterval(check, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  if (!text) return null

  return (
    <div className="event-ticker" role="status">
      <div className="event-ticker__track">
        {/* Duplicated so the loop is seamless — the animation scrolls by
            exactly one copy's width, so the second copy lands exactly
            where the first started. */}
        <span className="event-ticker__text">{text}</span>
        <span className="event-ticker__text" aria-hidden="true">
          {text}
        </span>
      </div>
    </div>
  )
}
