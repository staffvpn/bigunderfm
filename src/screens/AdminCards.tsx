// Admin "Карточки": visual cards for the channel and Instagram, filled in
// from the radio's own data. Drawn in the browser (see lib/cards.ts); the
// finished PNG goes to the worker, which keeps it in the library and sends
// it to Telegram: to the admin as a file, or to the channel as a post.
import { useEffect, useMemo, useRef, useState } from 'react'
import { api, ApiError } from '../lib/api'
import { fetchProgram } from '../lib/program'
import { BACKGROUND_ITEMS } from '../lib/backgrounds'
import { confirmAction } from '../lib/telegram'
import { FORMATS, canvasToBlob, loadImage, renderCard, type CardData, type CardFormat, type CardType } from '../lib/cards'

interface Show {
  id: string
  title: string
  days: string
  startMinute: number
  endMinute: number
}
interface SavedCard {
  id: string
  type: string
  format: string
  title: string
  url: string
  createdAt: string
  sentAt: string | null
}
interface LibraryEntry {
  track: { id: string; title: string; artist: string; kind: string; isEnabled: boolean }
}

const TYPES: { id: CardType; label: string }[] = [
  { id: 'now', label: 'Сейчас в эфире' },
  { id: 'show', label: 'Шоу' },
  { id: 'guest', label: 'Гость' },
  { id: 'select', label: 'Подборка' },
]
const DAY_NAMES = ['', 'ПОНЕДЕЛЬНИК', 'ВТОРНИК', 'СРЕДА', 'ЧЕТВЕРГ', 'ПЯТНИЦА', 'СУББОТА', 'ВОСКРЕСЕНЬЕ']
const DAY_SHORT = ['', 'ПН', 'ВТ', 'СР', 'ЧТ', 'ПТ', 'СБ', 'ВС']
const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
const daysLabel = (days: string) => {
  const list = [...days].map(Number).filter((d) => d >= 1 && d <= 7)
  if (list.length === 7) return 'КАЖДЫЙ ДЕНЬ'
  if (list.length <= 2) return list.map((d) => DAY_NAMES[d]).join(' · ')
  return list.map((d) => DAY_SHORT[d]).join(' · ')
}
const MSK_TIME = { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' } as const
const MSK_DATE = { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit' } as const

const EMPTY: CardData = {
  artist: '',
  title: '',
  label: '',
  time: '',
  showTitle: '',
  description: '',
  days: '',
  start: '',
  number: '',
  nameA: 'BIGUNDER',
  nameB: '',
  selTitle: 'Самое залайканное',
  selMood: '',
  curator: '',
  items: [],
  date: new Date().toLocaleDateString('ru-RU', MSK_DATE),
}

const PHOTOS = BACKGROUND_ITEMS.filter((b) => b.type === 'image').map((b) => b.src)

function defaultCaption(type: CardType, d: CardData): string {
  const tail = 'BIGUNDER FM. Underground on air.\n@bigunderadiobot'
  if (type === 'now') return `Сейчас в эфире: ${d.artist} — ${d.title}\n\n${tail}`
  if (type === 'show') return `${d.showTitle} — ${d.days}, ${d.start}.${d.description ? `\n${d.description}` : ''}\n\n${tail}`
  if (type === 'guest')
    return `${d.nameA}${d.nameB ? ` x ${d.nameB}` : ''}${d.showTitle ? ` — ${d.showTitle}` : ''}. ${[d.days, d.start].filter(Boolean).join(', ')}.\n\n${tail}`
  const list = d.items
    .slice(0, 6)
    .map((it, i) => `${String(i + 1).padStart(2, '0')}. ${it.artist} — ${it.title}`)
    .join('\n')
  return `${d.selTitle}${d.selMood ? `. ${d.selMood}` : ''}\n\n${list}\n\n${tail}`
}

export function AdminCards() {
  const params = useMemo(() => new URLSearchParams(location.search), [])
  const [type, setType] = useState<CardType>(params.get('card') === 'show' ? 'show' : 'now')
  const [format, setFormat] = useState<CardFormat>('feed')
  const [variant, setVariant] = useState(0)
  const [data, setData] = useState<CardData>(EMPTY)
  const [shows, setShows] = useState<Show[]>([])
  const [showId, setShowId] = useState<string>(params.get('slot') ?? '')
  const [photoIndex, setPhotoIndex] = useState(() => Math.floor(Math.random() * Math.max(1, PHOTOS.length)))
  const [ownPhoto, setOwnPhoto] = useState<HTMLImageElement | null>(null)
  const [photo, setPhoto] = useState<HTMLImageElement | null>(null)
  const [caption, setCaption] = useState('')
  const [captionTouched, setCaptionTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null)
  const [saved, setSaved] = useState<SavedCard[]>([])
  const [channel, setChannel] = useState('@bigunderparty')
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const patch = (p: Partial<CardData>) => setData((d) => ({ ...d, ...p }))

  // everything the cards can be filled from
  useEffect(() => {
    fetchProgram().then((p) => {
      if (!p) return
      const now = Date.now() + p.clockOffsetMs
      const cur = p.items.find((it) => Date.parse(it.startsAt) <= now && Date.parse(it.endsAt) > now && it.kind !== 'jingle') ?? p.items.find((it) => it.kind !== 'jingle')
      if (cur)
        patch({
          artist: cur.track.artist,
          title: cur.track.title,
          time: new Date(Date.parse(cur.startsAt)).toLocaleTimeString('ru-RU', MSK_TIME),
          label: p.slot?.label ?? p.slot?.title ?? '',
        })
    })
    api<{ shows: Show[] }>('/api/admin/air')
      .then((r) => setShows(r.shows ?? []))
      .catch(() => {})
    Promise.all([api<{ entries: LibraryEntry[] }>('/api/admin/library'), api<{ likes: Record<string, number> }>('/api/admin/rotation')])
      .then(([lib, rot]) => {
        const top = lib.entries
          .filter((e) => e.track.isEnabled && e.track.kind === 'track' && (rot.likes?.[e.track.id] ?? 0) > 0)
          .sort((a, b) => (rot.likes[b.track.id] ?? 0) - (rot.likes[a.track.id] ?? 0))
          .slice(0, 6)
          .map((e) => ({ artist: e.track.artist, title: e.track.title }))
        patch({ items: top })
      })
      .catch(() => {})
    loadSaved()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // a show picked (or opened from the bot's message) fills the show fields
  useEffect(() => {
    const s = shows.find((x) => x.id === showId) ?? (type === 'show' && !showId ? shows[0] : undefined)
    if (!s) return
    if (!showId) setShowId(s.id)
    patch({ showTitle: s.title, days: daysLabel(s.days), start: hhmm(s.startMinute) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shows, showId, type])

  useEffect(() => {
    if (ownPhoto) {
      setPhoto(ownPhoto)
      return
    }
    if (!PHOTOS.length) return
    loadImage(PHOTOS[photoIndex % PHOTOS.length])
      .then(setPhoto)
      .catch(() => setPhoto(null))
  }, [photoIndex, ownPhoto])

  useEffect(() => {
    if (!captionTouched) setCaption(defaultCaption(type, data))
  }, [type, data, captionTouched])

  // redraw on every change
  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    renderCard(c, { type, format, variant, data, photo }).catch(() => {})
  }, [type, format, variant, data, photo])

  function loadSaved() {
    api<{ cards: SavedCard[]; channel: string }>('/api/admin/cards')
      .then((r) => {
        setSaved(r.cards ?? [])
        if (r.channel) setChannel(r.channel)
      })
      .catch(() => {})
  }

  function pickOwnPhoto(file: File | undefined) {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      loadImage(String(reader.result))
        .then(setOwnPhoto)
        .catch(() => setNote({ text: 'Не получилось открыть фото', error: true }))
    }
    reader.readAsDataURL(file)
  }

  async function send(target: 'save' | 'me' | 'channel') {
    const c = canvasRef.current
    if (!c || busy) return
    if (target === 'channel' && !(await confirmAction(`Опубликовать карточку в ${channel}?`))) return
    setBusy(true)
    setNote(null)
    try {
      const png = await canvasToBlob(c)
      const form = new FormData()
      form.append('image', png, 'card.png')
      form.append('type', type)
      form.append('format', format)
      form.append('title', type === 'now' ? `${data.artist} — ${data.title}` : type === 'select' ? data.selTitle : data.showTitle || data.nameA)
      form.append('caption', caption)
      form.append('target', target)
      await api('/api/admin/cards', { method: 'POST', body: form })
      setNote({ text: target === 'channel' ? `Опубликовано в ${channel}` : target === 'me' ? 'Отправил тебе в бот. Оттуда можно сохранить или переслать' : 'Сохранено в библиотеку' })
    } catch (e) {
      setNote({ text: e instanceof ApiError ? e.message : 'Не получилось', error: true })
    } finally {
      setBusy(false)
      loadSaved()
    }
  }

  async function resend(card: SavedCard, target: 'me' | 'channel') {
    if (target === 'channel' && !(await confirmAction(`Опубликовать эту карточку в ${channel}?`))) return
    try {
      await api(`/api/admin/cards/${card.id}/send`, { method: 'POST', body: { target, caption } })
      setNote({ text: target === 'channel' ? `Опубликовано в ${channel}` : 'Отправил тебе в бот' })
      loadSaved()
    } catch (e) {
      setNote({ text: e instanceof ApiError ? e.message : 'Не получилось', error: true })
    }
  }

  async function remove(card: SavedCard) {
    if (!(await confirmAction('Удалить карточку из библиотеки?'))) return
    await api(`/api/admin/cards/${card.id}`, { method: 'DELETE' }).catch(() => {})
    loadSaved()
  }

  const field = (label: string, key: keyof CardData, multiline = false) => (
    <label className="cards__field">
      <span>{label}</span>
      {multiline ? (
        <textarea rows={2} value={String(data[key])} onChange={(e) => patch({ [key]: e.target.value } as Partial<CardData>)} />
      ) : (
        <input value={String(data[key])} onChange={(e) => patch({ [key]: e.target.value } as Partial<CardData>)} />
      )}
    </label>
  )

  return (
    <div className="cards">
      <div className="cards__label">Тип</div>
      <div className="cards__chips">
        {TYPES.map((t) => (
          <button key={t.id} className={t.id === type ? 'is-on' : ''} onClick={() => setType(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="cards__label">Формат</div>
      <div className="cards__chips">
        {(Object.keys(FORMATS) as CardFormat[]).map((f) => (
          <button key={f} className={f === format ? 'is-on' : ''} onClick={() => setFormat(f)}>
            {FORMATS[f].label}
          </button>
        ))}
      </div>

      <div className="cards__preview">
        <canvas ref={canvasRef} />
      </div>

      <div className="cards__row">
        <button onClick={() => setVariant((v) => v + 1)}>Ещё вариант</button>
        <button
          onClick={() => {
            setOwnPhoto(null)
            setPhotoIndex((i) => i + 1)
          }}
        >
          Другое фото
        </button>
        <button onClick={() => fileRef.current?.click()}>Своё фото</button>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => pickOwnPhoto(e.target.files?.[0])} />
      </div>

      {type === 'now' && (
        <>
          {field('Артист', 'artist')}
          {field('Трек', 'title')}
          {field('Эфир', 'label')}
          {field('Время', 'time')}
        </>
      )}
      {type === 'show' && (
        <>
          {shows.length > 0 && (
            <div className="cards__chips">
              {shows.map((s) => (
                <button key={s.id} className={s.id === showId ? 'is-on' : ''} onClick={() => setShowId(s.id)}>
                  {s.title}
                </button>
              ))}
            </div>
          )}
          {field('Название', 'showTitle')}
          {field('Описание', 'description', true)}
          {field('Дни', 'days')}
          {field('Время', 'start')}
          {field('Номер выпуска', 'number')}
        </>
      )}
      {type === 'guest' && (
        <>
          {field('Мы', 'nameA')}
          {field('Гость', 'nameB')}
          {field('Название эфира', 'showTitle')}
          {field('День', 'days')}
          {field('Время', 'start')}
        </>
      )}
      {type === 'select' && (
        <>
          {field('Название подборки', 'selTitle')}
          {field('Настроение', 'selMood')}
          {field('Куратор', 'curator')}
          <div className="cards__label">Треки (самые залайканные, можно поправить)</div>
          {data.items.map((it, i) => (
            <div key={i} className="cards__pair">
              <input value={it.artist} onChange={(e) => patch({ items: data.items.map((x, j) => (j === i ? { ...x, artist: e.target.value } : x)) })} />
              <input value={it.title} onChange={(e) => patch({ items: data.items.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)) })} />
            </div>
          ))}
          {data.items.length < 6 && <button onClick={() => patch({ items: [...data.items, { artist: '', title: '' }] })}>Добавить трек</button>}
        </>
      )}

      <label className="cards__field">
        <span>Подпись к посту</span>
        <textarea
          rows={5}
          value={caption}
          onChange={(e) => {
            setCaption(e.target.value)
            setCaptionTouched(true)
          }}
        />
      </label>

      {note && <div className={`cards__note${note.error ? ' is-error' : ''}`}>{note.text}</div>}
      <div className="cards__row">
        <button disabled={busy} onClick={() => send('me')}>
          Мне в бот
        </button>
        <button disabled={busy} onClick={() => send('save')}>
          В библиотеку
        </button>
      </div>
      <button className="cards__publish" disabled={busy} onClick={() => send('channel')}>
        {busy ? 'Отправляю…' : `Отправить в канал ${channel}`}
      </button>

      {saved.length > 0 && (
        <>
          <div className="cards__label">Библиотека карточек</div>
          <div className="cards__lib">
            {saved.map((c) => (
              <div key={c.id} className="cards__item">
                <img src={c.url} alt="" loading="lazy" />
                <div className="cards__item-title">{c.title || c.type}</div>
                <div className="cards__item-meta">{c.sentAt ? 'В канале' : new Date(c.createdAt).toLocaleDateString('ru-RU', MSK_DATE)}</div>
                <div className="cards__item-btns">
                  <button onClick={() => resend(c, 'me')}>Мне</button>
                  <button onClick={() => resend(c, 'channel')}>В канал</button>
                  <button onClick={() => remove(c)}>×</button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
