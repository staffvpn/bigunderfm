import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { applyAccent } from '../lib/accent'
import { confirmAction } from '../lib/telegram'

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
// Strong colours that keep white text readable on buttons.
const SWATCHES = ['#1f2bff', '#e10600', '#0a0a0a', '#ff5a00', '#00873e', '#7a1fff']
const DAYS = ['ПН', 'ВТ', 'СР', 'ЧТ', 'ПТ', 'СБ', 'ВС']
const toTime = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
const toMinute = (t: string) => {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}

/** Name, days and hours of a show: the same fields for editing and for a new one. */
function showFields(show: Show, change: (patch: Partial<Show>) => void) {
  return (
    <>
      <label className="admin-air__field">
        <span>Название</span>
        <input value={show.title} maxLength={60} onChange={(e) => change({ title: e.target.value })} />
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
              onClick={() => change({ days: on ? show.days.replace(digit, '') : [...show.days, digit].sort().join('') })}
            >
              {d}
            </button>
          )
        })}
      </div>
      <div className="admin-air__times">
        <label className="admin-air__field">
          <span>Начало</span>
          <input type="time" value={toTime(show.startMinute)} onChange={(e) => e.target.value && change({ startMinute: toMinute(e.target.value) })} />
        </label>
        <label className="admin-air__field">
          <span>Конец</span>
          <input type="time" value={toTime(show.endMinute)} onChange={(e) => e.target.value && change({ endMinute: toMinute(e.target.value) })} />
        </label>
      </div>
    </>
  )
}

export function AdminAir() {
  const [names, setNames] = useState<Names | null>(null)
  const [shows, setShows] = useState<Show[]>([])
  const [note, setNote] = useState<Record<string, string>>({})
  const [accent, setAccent] = useState('#1f2bff')

  useEffect(() => {
    api<{ names: Names; shows: Show[]; accent: string }>('/api/admin/air')
      .then((data) => {
        setAccent(data.accent)
        setNames(data.names)
        setShows(data.shows)
      })
      .catch(() => setNote({ names: 'Не удалось загрузить' }))
  }, [])

  async function saveAccent(color: string) {
    setAccent(color)
    applyAccent(color)
    try {
      await api('/api/admin/accent', { method: 'PUT', body: { color } })
      setNote((n) => ({ ...n, accent: 'Сохранено, у слушателей сменится в течение минуты' }))
    } catch {
      setNote((n) => ({ ...n, accent: 'Не сохранилось' }))
    }
  }

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

  const [draft, setDraft] = useState<Show>({ id: 'new', title: '', days: '6', startMinute: 21 * 60, endMinute: 22 * 60 })
  function reloadShows() {
    api<{ shows: Show[] }>('/api/admin/air')
      .then((data) => setShows(data.shows))
      .catch(() => {})
  }
  async function createShow() {
    setNote((n) => ({ ...n, new: 'Создаю...' }))
    try {
      await api('/api/admin/shows', { method: 'POST', body: draft })
      setDraft({ ...draft, title: '' })
      setNote((n) => ({ ...n, new: 'Шоу создано. Положи в его папку треки в библиотеке, и оно выйдет в эфир в своё время.' }))
      reloadShows()
    } catch (err) {
      setNote((n) => ({ ...n, new: err instanceof Error && err.message ? err.message : 'Не получилось' }))
    }
  }
  async function deleteShow(show: Show) {
    if (!(await confirmAction(`Удалить шоу ${show.title}? Треки останутся в библиотеке.`))) return
    try {
      await api(`/api/admin/shows/${show.id}`, { method: 'DELETE' })
      reloadShows()
    } catch (err) {
      setNote((n) => ({ ...n, [show.id]: err instanceof Error && err.message ? err.message : 'Не получилось' }))
    }
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
      <div className="admin-air admin-air--accent">
        <span className="admin-air__title">Акцентный цвет</span>
        <div className="admin-air__swatches">
          {SWATCHES.map((c) => (
            <button key={c} type="button" aria-label={c} className={c === accent ? 'is-on' : ''} style={{ background: c }} onClick={() => saveAccent(c)} />
          ))}
          <label className="admin-air__custom" aria-label="Свой цвет">
            <input type="color" value={accent} onChange={(e) => setAccent(e.target.value)} onBlur={(e) => saveAccent(e.target.value)} />
          </label>
        </div>
        {note.accent && <p className="admin-air__note">{note.accent}</p>}
      </div>
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
            {showFields(show, (patch) => patchShow(show.id, patch))}
            <div className="admin-air__actions">
              <button onClick={() => saveShow(show)}>Сохранить шоу</button>
              <button className="admin-air__delete" onClick={() => deleteShow(show)}>
                Удалить
              </button>
            </div>
            {note[show.id] && <p className="admin-air__note">{note[show.id]}</p>}
          </div>
        ))}
        <div className="admin-air__show">
          <span className="admin-air__title">Новое шоу</span>
          {showFields(draft, (patch) => setDraft({ ...draft, ...patch }))}
          <button onClick={createShow} disabled={!draft.title.trim() || !draft.days}>
            Добавить шоу
          </button>
          {note.new && <p className="admin-air__note">{note.new}</p>}
        </div>
      </div>
    </>
  )
}
