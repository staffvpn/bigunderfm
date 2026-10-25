import { useEffect, useState } from 'react'
import { ApiError } from '../lib/api'
import { fetchEvents, remindMe, type EventItem } from '../lib/events'
import { FitTitle } from '../components/FitTitle'

type RemindState = 'idle' | 'sending' | 'done' | 'error'

// Row labels as on bigunder.ru: weekday, date and time in small caps, local time.
const weekday = (d: Date) => d.toLocaleDateString('ru-RU', { weekday: 'short' }).toUpperCase().replace('.', '')
const dayMonth = (d: Date) => `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`
const time = (d: Date) => d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })

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
  // The row whose description and reminder button are shown.
  const [openId, setOpenId] = useState<string | null>(null)
  const now = Date.now()
  const today = new Date(now).toDateString()

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

        <div>
          <h2 className="page-title">шоу</h2>
          <span className="page-sub">Расписание эфиров</span>
        </div>

        <div className="schedule-tabs" role="tablist">
          <button
            role="tab"
            aria-selected={view === 'upcoming'}
            className={`schedule-tab${view === 'upcoming' ? ' is-active' : ''}`}
            onClick={() => setView('upcoming')}
          >
            ПРЕДСТОЯЩИЕ
          </button>
          <button
            role="tab"
            aria-selected={view === 'past'}
            className={`schedule-tab${view === 'past' ? ' is-active' : ''}`}
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
          <ol className="slist">
            {shown.map((event) => {
              const state = remindState[event.id] ?? 'idle'
              const isPast = view === 'past'
              const when = new Date(event.eventAt)
              const isOpen = openId === event.id
              // Like the site's schedule: today's shows in ink, the rest pale.
              const isToday = when.toDateString() === today
              return (
                <li key={event.id} className={`slist__row${isToday ? ' is-today' : ''}${isOpen ? ' is-open' : ''}`}>
                  <button type="button" className="slist__line" onClick={() => setOpenId(isOpen ? null : event.id)}>
                    <span className="slist__d">
                      {isToday ? 'СЕГОДНЯ' : `${weekday(when)} ${dayMonth(when)}`}
                      <br />
                      {time(when)}
                    </span>
                    <FitTitle className="slist__n" text={event.title} />
                  </button>
                  {isOpen && (event.description || !isPast) && (
                    <div className="slist__more">
                      {event.description && <p className="slist__description">{event.description}</p>}
                      {!isPast && (
                        <button
                          type="button"
                          className="slist__remind"
                          onClick={() => handleRemind(event.id)}
                          disabled={state === 'sending' || state === 'done'}
                        >
                          {remindLabel(state)}
                        </button>
                      )}
                      {remindNote[event.id] && <span className="schedule-screen__remind-note">{remindNote[event.id]}</span>}
                    </div>
                  )}
                </li>
              )
            })}
          </ol>
        )}
      </div>
    </div>
  )
}
