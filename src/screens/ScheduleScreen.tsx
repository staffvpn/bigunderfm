import { useEffect, useState } from 'react'
import { fetchEvents, type EventItem } from '../lib/events'
import { formatEventDateTime } from '../lib/format'

// A separate `.schedule-screen` container rather than reusing `.radio-screen`
// (like InfoScreen does) — that one is fixed-height with overflow hidden,
// which fits a handful of static links but would just clip a growing list
// of events instead of scrolling.
export function ScheduleScreen() {
  const [events, setEvents] = useState<EventItem[] | null>(null)

  useEffect(() => {
    fetchEvents().then(setEvents)
  }, [])

  return (
    <div className="schedule-screen">
      <div className="schedule-screen__content">
        <div className="radio-screen__header">
          <span className="radio-screen__station">BIGUNDER FM</span>
        </div>

        <h2>SCHEDULE</h2>

        {events === null ? null : events.length === 0 ? (
          <p className="schedule-screen__empty">Пока нет анонсированных событий — загляните позже.</p>
        ) : (
          <ul className="schedule-screen__list">
            {events.map((event) => (
              <li key={event.id} className="schedule-screen__item">
                {event.imageUrl && (
                  <img src={event.imageUrl} alt="" className="schedule-screen__item-image" />
                )}
                <div className="schedule-screen__item-body">
                  <span className="schedule-screen__item-datetime">{formatEventDateTime(event.eventAt)}</span>
                  <span className="schedule-screen__item-title">{event.title}</span>
                  {event.description && (
                    <span className="schedule-screen__item-description">{event.description}</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
