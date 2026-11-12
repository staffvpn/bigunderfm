import { useEffect, useState } from 'react'
import { api } from '../lib/api'

// What listeners read on the main screen instead of the folder names
// (morning / day / evening / night), and the shows: name, days, time.

interface Show {
  id: string
  title: string
  days: string
  startMinute: number
  endMinute: number
}
type Names = Record<'morning' | 'day' | 'evening' | 'night', string>

const PARTS: [keyof Names, string][] = [
  ['morning', 'Утро'],
  ['day', 'День'],
  ['evening', 'Вечер'],
  ['night', 'Ночь'],
]
const DAYS = ['ПН', 'ВТ', 'СР', 'ЧТ', 'ПТ', 'СБ', 'ВС']
const toTime = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
const toMinute = (t: string) => {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}

export function AdminAir() {
  const [names, setNames] = useState<Names | null>(null)
  const [shows, setShows] = useState<Show[]>([])
  const [note, setNote] = useState<Record<string, string>>({})

  useEffect(() => {
    api<{ names: Names; shows: Show[] }>('/api/admin/air')
      .then((data) => {
        setNames(data.names)
        setShows(data.shows)
      })
      .catch(() => setNote({ names: 'Не удалось загрузить' }))
  }, [])

  async function saveNames() {
    if (!names) return
    setNote((n) => ({ ...n, names: 'Сохраняю...' }))
    try {
      const data = await api<{ names: Names }>('/api/admin/air-names', { method: 'PUT', body: names })
      setNames(data.names)
      setNote((n) => ({ ...n, names: 'Сохранено' }))
    } catch {
      setNote((n) => ({ ...n, names: 'Не сохранилось' }))
    }
  }

  function patchShow(id: string, patch: Partial<Show>) {
    setShows((list) => list.map((s) => (s.id === id ? { ...s, ...patch } : s)))
    setNote((n) => ({ ...n, [id]: '' }))
  }

  async function saveShow(show: Show) {
    setNote((n) => ({ ...n, [show.id]: 'Сохраняю...' }))
    try {
      await api(`/api/admin/shows/${show.id}`, { method: 'PUT', body: show })
      setNote((n) => ({ ...n, [show.id]: 'Сохранено' }))
    } catch (err) {
      setNote((n) => ({ ...n, [show.id]: err instanceof Error && err.message ? err.message : 'Не сохранилось' }))
    }
  }

  return (
    <>
      <div className="admin-air">
        <span className="admin-air__title">Названия эфира</span>
        <p className="admin-air__hint">Так части дня называются на главном экране. {'{DAY}'} заменяется днём недели на английском.</p>
        {names &&
          PARTS.map(([key, label]) => (
            <label className="admin-air__field" key={key}>
              <span>{label}</span>
              <input value={names[key]} maxLength={40} onChange={(e) => setNames({ ...names, [key]: e.target.value })} />
            </label>
          ))}
        <button onClick={saveNames} disabled={!names}>
          Сохранить названия
        </button>
        {note.names && <p className="admin-air__note">{note.names}</p>}
      </div>

      <div className="admin-air">
        <span className="admin-air__title">Шоу</span>
        <p className="admin-air__hint">Шоу выходит в эфир само в своё время, если в его папке есть треки.</p>
        {shows.map((show) => (
          <div className="admin-air__show" key={show.id}>
            <label className="admin-air__field">
              <span>Название</span>
              <input value={show.title} maxLength={60} onChange={(e) => patchShow(show.id, { title: e.target.value })} />
            </label>
            <div className="admin-air__days">
              {DAYS.map((d, i) => {
                const digit = String(i + 1)
                const on = show.days.includes(digit)
                return (
                  <button
                    key={d}
                    type="button"
                    className={on ? 'is-on' : ''}
                    aria-pressed={on}
                    onClick={() => patchShow(show.id, { days: on ? show.days.replace(digit, '') : [...show.days, digit].sort().join('') })}
                  >
                    {d}
                  </button>
                )
              })}
            </div>
            <div className="admin-air__times">
              <label className="admin-air__field">
                <span>Начало</span>
                <input type="time" value={toTime(show.startMinute)} onChange={(e) => e.target.value && patchShow(show.id, { startMinute: toMinute(e.target.value) })} />
              </label>
              <label className="admin-air__field">
                <span>Конец</span>
                <input type="time" value={toTime(show.endMinute)} onChange={(e) => e.target.value && patchShow(show.id, { endMinute: toMinute(e.target.value) })} />
              </label>
            </div>
            <button onClick={() => saveShow(show)}>Сохранить шоу</button>
            {note[show.id] && <p className="admin-air__note">{note[show.id]}</p>}
          </div>
        ))}
      </div>
    </>
  )
}
