import { useEffect, useState } from 'react'
import { createEvent, deleteEvent, fetchAdminEvents, updateEvent, type EventItem } from '../lib/events'
import { formatEventDateTime } from '../lib/format'

const IMAGE_INPUT_ID = 'admin-schedule-image-input'

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** Splits a UTC ISO timestamp into the <input type="date">/<input type="time">
    values that show it in the admin's own local time. */
function toLocalDateTimeInputs(iso: string): { date: string; time: string } {
  const d = new Date(iso)
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  }
}

/** Combines the two local inputs back into a value the backend can parse
    (new Date() reads "YYYY-MM-DDTHH:MM" as local time, same zone as the
    inputs themselves — the round trip through toISOString() below the
    caller does is what actually converts it to UTC for storage). */
function combineDateTime(date: string, time: string): string {
  return `${date}T${time || '00:00'}`
}

interface DraftFields {
  title: string
  description: string
  date: string
  time: string
}

const EMPTY_DRAFT: DraftFields = { title: '', description: '', date: '', time: '' }

export function AdminSchedule() {
  const [events, setEvents] = useState<EventItem[]>([])
  const [draft, setDraft] = useState<DraftFields>(EMPTY_DRAFT)
  const [draftImage, setDraftImage] = useState<File | null>(null)
  const [creating, setCreating] = useState(false)
  const [results, setResults] = useState<string[]>([])

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState<DraftFields>(EMPTY_DRAFT)
  const [editImage, setEditImage] = useState<File | null>(null)
  const [editRemoveImage, setEditRemoveImage] = useState(false)
  const [savingEdit, setSavingEdit] = useState(false)

  async function reload() {
    setEvents(await fetchAdminEvents())
  }

  useEffect(() => {
    reload()
  }, [])

  async function handleCreate() {
    const title = draft.title.trim()
    if (!title) {
      setResults(['ОШИБКА: название не может быть пустым'])
      return
    }
    if (!draft.date || !draft.time) {
      setResults(['ОШИБКА: укажи дату и время'])
      return
    }
    setCreating(true)
    try {
      const form = new FormData()
      form.append('title', title)
      form.append('description', draft.description.trim())
      form.append('eventAt', combineDateTime(draft.date, draft.time))
      if (draftImage) form.append('image', draftImage)
      await createEvent(form)
      setDraft(EMPTY_DRAFT)
      setDraftImage(null)
      setResults([`ГОТОВО: ${title}`])
    } catch (err) {
      setResults([`ОШИБКА: ${(err as Error).message}`])
    } finally {
      setCreating(false)
    }
    reload()
  }

  function startEdit(event: EventItem) {
    const { date, time } = toLocalDateTimeInputs(event.eventAt)
    setEditingId(event.id)
    setEditDraft({ title: event.title, description: event.description, date, time })
    setEditImage(null)
    setEditRemoveImage(false)
  }

  function cancelEdit() {
    setEditingId(null)
  }

  async function saveEdit(id: string) {
    const title = editDraft.title.trim()
    if (!title) {
      setResults(['ОШИБКА: название не может быть пустым'])
      return
    }
    if (!editDraft.date || !editDraft.time) {
      setResults(['ОШИБКА: укажи дату и время'])
      return
    }
    setSavingEdit(true)
    try {
      const form = new FormData()
      form.append('title', title)
      form.append('description', editDraft.description.trim())
      form.append('eventAt', combineDateTime(editDraft.date, editDraft.time))
      if (editImage) form.append('image', editImage)
      else if (editRemoveImage) form.append('removeImage', '1')
      await updateEvent(id, form)
      setEditingId(null)
    } catch (err) {
      setResults([`ОШИБКА: ${(err as Error).message}`])
    } finally {
      setSavingEdit(false)
    }
    reload()
  }

  async function handleDelete(id: string) {
    if (!window.confirm('Удалить это событие?')) return
    try {
      await deleteEvent(id)
    } catch (err) {
      setResults([`ОШИБКА УДАЛЕНИЯ: ${(err as Error).message}`])
    }
    reload()
  }

  const now = Date.now()

  return (
    <div className="admin-schedule">
      <h2>SCHEDULE</h2>

      <div className="admin-schedule__form">
        <input
          className="admin-schedule__input"
          value={draft.title}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          placeholder="Название события"
          maxLength={200}
        />
        <textarea
          className="admin-schedule__input admin-schedule__input--textarea"
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          placeholder="Описание (кто выступает, где, что взять с собой...)"
          rows={3}
          maxLength={2000}
        />
        <div className="admin-schedule__form-row">
          <input
            className="admin-schedule__input"
            type="date"
            value={draft.date}
            onChange={(e) => setDraft({ ...draft, date: e.target.value })}
          />
          <input
            className="admin-schedule__input"
            type="time"
            value={draft.time}
            onChange={(e) => setDraft({ ...draft, time: e.target.value })}
          />
        </div>
        <label htmlFor={IMAGE_INPUT_ID} className="admin-schedule__image-button">
          {draftImage ? draftImage.name : 'Прикрепить картинку'}
        </label>
        <input
          id={IMAGE_INPUT_ID}
          className="admin-library__file-input"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={(e) => setDraftImage(e.target.files?.[0] ?? null)}
        />
        <button onClick={handleCreate} disabled={creating}>
          {creating ? 'ДОБАВЛЯЮ...' : 'ДОБАВИТЬ СОБЫТИЕ'}
        </button>
      </div>

      <ul className="admin-library__results">
        {results.map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ul>

      <ul className="admin-schedule__list">
        {events.map((event) => {
          const isPast = new Date(event.eventAt).getTime() < now
          return (
            <li key={event.id} className={`admin-schedule__item${isPast ? ' is-past' : ''}`}>
              {editingId === event.id ? (
                <div className="admin-schedule__form">
                  <input
                    className="admin-schedule__input"
                    value={editDraft.title}
                    onChange={(e) => setEditDraft({ ...editDraft, title: e.target.value })}
                    placeholder="Название события"
                    maxLength={200}
                    autoFocus
                  />
                  <textarea
                    className="admin-schedule__input admin-schedule__input--textarea"
                    value={editDraft.description}
                    onChange={(e) => setEditDraft({ ...editDraft, description: e.target.value })}
                    placeholder="Описание"
                    rows={3}
                    maxLength={2000}
                  />
                  <div className="admin-schedule__form-row">
                    <input
                      className="admin-schedule__input"
                      type="date"
                      value={editDraft.date}
                      onChange={(e) => setEditDraft({ ...editDraft, date: e.target.value })}
                    />
                    <input
                      className="admin-schedule__input"
                      type="time"
                      value={editDraft.time}
                      onChange={(e) => setEditDraft({ ...editDraft, time: e.target.value })}
                    />
                  </div>
                  {event.imageUrl && !editImage && (
                    <label className="admin-schedule__remove-image">
                      <input
                        type="checkbox"
                        checked={editRemoveImage}
                        onChange={(e) => setEditRemoveImage(e.target.checked)}
                      />
                      Убрать текущую картинку
                    </label>
                  )}
                  <label htmlFor={`${IMAGE_INPUT_ID}-${event.id}`} className="admin-schedule__image-button">
                    {editImage ? editImage.name : 'Заменить картинку'}
                  </label>
                  <input
                    id={`${IMAGE_INPUT_ID}-${event.id}`}
                    className="admin-library__file-input"
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    onChange={(e) => {
                      setEditImage(e.target.files?.[0] ?? null)
                      setEditRemoveImage(false)
                    }}
                  />
                  <div className="admin-library__actions">
                    <button onClick={() => saveEdit(event.id)} disabled={savingEdit}>
                      {savingEdit ? 'СОХРАНЯЮ...' : 'Сохранить'}
                    </button>
                    <button onClick={cancelEdit} disabled={savingEdit}>
                      Отмена
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="admin-schedule__row">
                    {event.imageUrl && (
                      <img src={event.imageUrl} alt="" className="schedule-screen__item-image" />
                    )}
                    <div className="schedule-screen__item-body">
                      <span className="schedule-screen__item-datetime">
                        {formatEventDateTime(event.eventAt)}
                        {isPast ? ' · ПРОШЛО' : ''}
                      </span>
                      <span className="schedule-screen__item-title">{event.title}</span>
                      {event.description && (
                        <span className="schedule-screen__item-description">{event.description}</span>
                      )}
                    </div>
                  </div>
                  <div className="admin-library__actions">
                    <button onClick={() => startEdit(event)}>Изменить</button>
                    <button onClick={() => handleDelete(event.id)}>Удалить</button>
                  </div>
                </>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
