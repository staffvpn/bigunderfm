import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { decodeHtmlEntities } from '../lib/radioServer'

// "Что играло": a quiet link under the next track opens a sheet with the
// last tracks on air, laid out like the lists on bigunder.ru — time in small
// caps, artist heavy, title in italic serif; the current one in ink.
// The radio backend notes every track change once a minute.

interface Played {
  artist: string
  title: string
  at: Date
}

async function fetchPlayed(): Promise<Played[]> {
  try {
    const data = await api<{ items: { title: string; playedAt: string }[] }>('/api/history')
    return data.items.map((item) => {
      const full = decodeHtmlEntities(item.title)
      const [artist, ...rest] = full.split(' - ')
      return { artist: rest.length ? artist : '', title: rest.join(' - ') || full, at: new Date(item.playedAt) }
    })
  } catch {
    return []
  }
}

const clock = (d: Date) => d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })

export function PlayedHistory() {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<Played[] | null>(null)

  useEffect(() => {
    if (!open) return
    fetchPlayed().then(setItems)
    const close = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [open])

  return (
    <>
      <button type="button" className="played__open" onClick={() => setOpen(true)}>
        Что играло
      </button>

      {open && (
        <div className="played" onClick={() => setOpen(false)}>
          <div className="played__sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Что играло">
            <div className="played__head">
              <h2 className="page-title played__title">что играло</h2>
              <button type="button" className="played__close" onClick={() => setOpen(false)}>
                Закрыть
              </button>
            </div>
            {items === null ? null : items.length === 0 ? (
              <p className="played__empty">Пока пусто</p>
            ) : (
              <ol className="played__list">
                {items.map((p, i) => (
                  <li key={`${p.at.getTime()}-${i}`} className={i === 0 ? 'is-now' : ''}>
                    <span className="played__time">{i === 0 ? 'сейчас' : clock(p.at)}</span>
                    <span className="played__track">
                      {p.artist && <b>{p.artist}</b>} <i>{p.title}</i>
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      )}
    </>
  )
}
