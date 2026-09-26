import { useEffect, useState } from 'react'
import { createEvent, deleteEvent, fetchAdminEvents, updateEvent, type EventItem } from '../lib/events'
import { formatEventDateTime } from '../lib/format'

const IMAGE_INPUT_ID = 'admin-schedule-image-input'

// Admins always enter a start time meaning Moscow time, whoever they are and
// wherever their own device's clock/timezone is set — that's the one
// convention everyone scheduling an event agrees on. Listeners then see it
// converted to THEIR own local time (formatEventDateTime does that with a
// plain `new Date(iso)` + toLocaleTimeString, no MSK-specific code needed
// there). Moscow has used a fixed UTC+3 with no DST since 2014, so this
// never needs a seasonal adjustment.
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** Splits a UTC ISO timestamp into the <input type="date">/<input type="time">
    values that show it in MOSCOW time. Shifts by the MSK offset and then
    reads the result back with the UTC getters — using the local getters
    here would additionally apply whatever timezone the admin's own browser
    happens to be in, silently corrupting the value a second time. */
function toMskDateTimeInputs(iso: string): { date: string; time: string } {
  const d = new Date(new Date(iso).getTime() + MSK_OFFSET_MS)
  return {
    date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
  }
}

/** Turns the two MSK-time inputs into a real UTC instant for the backend.
    Date.UTC() treats its numeric arguments as UTC components regardless of
    the admin's own device timezone, so subtracting the MSK offset here
    gives the correct absolute time no matter where the admin actually is —
    unlike `new Date("YYYY-MM-DDTHH:MM")`, which the JS engine reads as
    LOCAL time (the machine running the code's own zone), and which is what
    silently saved the wrong time before this fix. */
function mskInputsToIso(date: string, time: string): string {
  const [year, month, day] = date.split('-').map(Number)
  const [hour, minute] = (time || '00:00').split(':').map(Number)
  return new Date(Date.UTC(year, month - 1, day, hour, minute) - MSK_OFFSET_MS).toISOString()
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
  const [editError, setEditError] = useState<string | null>(null)

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
      form.append('eventAt', mskInputsToIso(draft.date, draft.time))
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
    const { date, time } = toMskDateTimeInputs(event.eventAt)
    setEditingId(event.id)
    setEditDraft({ title: event.title, description: event.description, date, time })
    setEditImage(null)
    setEditRemoveImage(false)
    setEditError(null)
  }

  function cancelEdit() {
    setEditingId(null)
  }

  // A shared results box up near the create form is easy to miss while
  // editing a card further down the list — a failed save (or a validation
  // miss) then reads as "nothing happened" rather than as an error. This
  // renders right next to the Save/Cancel buttons instead.
  async function saveEdit(id: string) {
    const title = editDraft.title.trim()
    if (!title) {
      setEditError('Название не может быть пустым')
      return
    }
    if (!editDraft.date || !editDraft.time) {
      setEditError('Укажи дату и время')
      return
    }
    setEditError(null)
    setSavingEdit(true)
    try {
      const form = new FormData()
      form.append('title', title)
      form.append('description', editDraft.description.trim())
      form.append('eventAt', mskInputsToIso(editDraft.date, editDraft.time))
      if (editImage) form.append('image', editImage)
      else if (editRemoveImage) form.append('removeImage', '1')
      await updateEvent(id, form)
      setEditingId(null)
    } catch (err) {
      setEditError((err as Error).message)
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
        <span className="admin-schedule__hint">Время по МСК — каждый слушатель увидит его в своём часовом поясе</span>
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
                  <span className="admin-schedule__hint">Время по МСК — каждый слушатель увидит его в своём часовом поясе</span>
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
                  {editError && <p className="admin-radio-controls__error">{editError}</p>}
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
