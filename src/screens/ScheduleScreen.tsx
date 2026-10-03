import { useEffect, useState } from 'react'
import { ApiError } from '../lib/api'
import { fetchEvents, remindMe, type EventItem } from '../lib/events'
import { formatEventDateTime } from '../lib/format'

type RemindState = 'idle' | 'sending' | 'done' | 'error'

function remindLabel(state: RemindState): string {
  switch (state) {
    case 'sending':
      return 'ОТПРАВЛЯЮ...'
    case 'done':
      return 'НАПОМНЮ ✓'
    case 'error':
      return 'ПОВТОРИТЬ'
    default:
      return 'НАПОМНИТЬ'
  }
}

// A separate `.schedule-screen` container rather than reusing `.radio-screen`
// (like InfoScreen does) — that one is fixed-height with overflow hidden,
// which fits a handful of static links but would just clip a growing list
// of events instead of scrolling.
export function ScheduleScreen() {
  const [events, setEvents] = useState<EventItem[] | null>(null)
  const [remindState, setRemindState] = useState<Record<string, RemindState>>({})
  const [remindNote, setRemindNote] = useState<Record<string, string>>({})
  const [view, setView] = useState<'upcoming' | 'past'>('upcoming')
  const now = Date.now()

  useEffect(() => {
    fetchEvents().then(setEvents)
  }, [])

  const upcoming = events?.filter((e) => new Date(e.eventAt).getTime() >= now) ?? []
  const past = (events?.filter((e) => new Date(e.eventAt).getTime() < now) ?? []).reverse()
  const shown = view === 'upcoming' ? upcoming : past

  async function handleRemind(eventId: string) {
    setRemindState((s) => ({ ...s, [eventId]: 'sending' }))
    setRemindNote((s) => ({ ...s, [eventId]: '' }))
    try {
      const result = await remindMe(eventId)
      setRemindState((s) => ({ ...s, [eventId]: 'done' }))
      if (!result.messaged) {
        setRemindNote((s) => ({
          ...s,
          [eventId]: 'Записал, но бот пока не может тебе написать — сначала нажми Start у @bigunderadiobot.',
        }))
      }
    } catch (err) {
      setRemindState((s) => ({ ...s, [eventId]: 'error' }))
      const message =
        err instanceof ApiError && err.status === 401
          ? 'Открой это в Telegram, чтобы получать напоминания.'
          : (err as Error).message
      setRemindNote((s) => ({ ...s, [eventId]: message }))
    }
  }

  return (
    <div className="schedule-screen">
      <div className="schedule-screen__content">
        <div className="radio-screen__header">
          <span className="radio-screen__station">BIGUNDER FM</span>
        </div>

        <h2>SCHEDULE</h2>

        <div className="schedule-screen__tabs" role="tablist">
          <button
            role="tab"
            aria-selected={view === 'upcoming'}
            className={`schedule-screen__tab${view === 'upcoming' ? ' is-active' : ''}`}
            onClick={() => setView('upcoming')}
          >
            ПРЕДСТОЯЩИЕ
          </button>
          <button
            role="tab"
            aria-selected={view === 'past'}
            className={`schedule-screen__tab${view === 'past' ? ' is-active' : ''}`}
            onClick={() => setView('past')}
          >
            ПРОШЕДШИЕ
          </button>
        </div>

        {events === null ? null : shown.length === 0 ? (
          <p className="schedule-screen__empty">
            {view === 'upcoming'
              ? 'Пока нет анонсированных событий — загляните позже.'
              : 'Прошедших событий пока нет.'}
          </p>
        ) : (
          <ul className="schedule-screen__list">
            {shown.map((event) => {
              const state = remindState[event.id] ?? 'idle'
              const isPast = view === 'past'
              return (
                <li key={event.id} className="schedule-screen__item">
                  <div className="schedule-screen__item-main">
                    {event.imageUrl && (
                      <img src={event.imageUrl} alt="" className="schedule-screen__item-image" />
                    )}
                    <div className="schedule-screen__item-body">
                      <span className="schedule-screen__item-datetime">{formatEventDateTime(event.eventAt)}{isPast ? ' · ПРОШЛО' : ''}</span>
                      <span className="schedule-screen__item-title">{event.title}</span>
                      {event.description && (
                        <span className="schedule-screen__item-description">{event.description}</span>
                      )}
                    </div>
                  </div>
                  <button
                    className="schedule-screen__remind-button"
                    onClick={() => handleRemind(event.id)}
                    disabled={isPast || state === 'sending' || state === 'done'}
                  >
                    {remindLabel(state)}
                  </button>
                  {remindNote[event.id] && (
                    <span className="schedule-screen__remind-note">{remindNote[event.id]}</span>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
