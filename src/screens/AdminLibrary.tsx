import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { api } from '../lib/api'
import { fetchPlaylist, type PlaylistEntry } from '../lib/tracks'
import { formatDuration } from '../lib/format'
import { getTelegramUserId } from '../lib/telegram'

const FILE_INPUT_ID = 'admin-library-file-input'

// Shuffle reorders the ENTIRE live rotation, which every other admin also
// relies on staying predictable — restricted to this one admin's own
// Telegram account per explicit request, everyone else just doesn't see
// the button at all (not a real access boundary, just keeps it out of
// reach of someone who could tap it by accident; RLS/telegram-auth are
// what actually gate the underlying writes for every admin equally).
const SHUFFLE_ADMIN_TELEGRAM_ID = 432943377

export function AdminLibrary() {
  const [entries, setEntries] = useState<PlaylistEntry[]>([])
  const [uploading, setUploading] = useState(false)
  const [shuffling, setShuffling] = useState(false)
  const [results, setResults] = useState<string[]>([])
  // Local-only visual order while a drag is in progress — the server only
  // hears about it once via commitOrder() on release, not on every move.
  const [dragOrderIds, setDragOrderIds] = useState<string[] | null>(null)
  const draggingIdRef = useRef<string | null>(null)
  const listRef = useRef<HTMLUListElement>(null)
  // Last known pointer position during a drag, kept fresh even when the
  // finger/mouse itself has stopped moving (see autoScrollTick below).
  const dragPointerRef = useRef<{ x: number; y: number } | null>(null)
  const autoScrollRafRef = useRef<number | null>(null)

  async function reload() {
    // includeDisabled: the admin must still see (and be able to re-enable)
    // disabled tracks, and reorder renumbering must cover every row.
    setEntries(await fetchPlaylist({ includeDisabled: true }))
  }

  useEffect(() => {
    reload()
    // Switching tabs away mid-drag unmounts this screen (see App.tsx) —
    // without this, the auto-scroll rAF loop would keep running against a
    // gone component, still scrolling whatever tab replaced it.
    return () => {
      if (autoScrollRafRef.current !== null) {
        cancelAnimationFrame(autoScrollRafRef.current)
      }
    }
  }, [])

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return
    setUploading(true)
    const log: string[] = []

    // Loaded on demand so the ID3 parser is not bundled into the listener's
    // initial download — only an admin who actually uploads ever fetches it.
    const { extractTrackMetadata } = await import('../lib/metadata')

    for (const file of Array.from(files)) {
      try {
        const meta = await extractTrackMetadata(file)

        // A zero-duration track occupies no time in the rotation and would
        // silently become unplayable dead weight. Reject it up front.
        if (meta.durationSeconds <= 0) {
          log.push(`ОШИБКА: ${file.name} (не удалось определить длительность)`)
          continue
        }

        // One request: the backend stores the file (and cover) in R2, adds the
        // track to the end of the playlist, and rolls everything back itself
        // if any step fails, so nothing is left orphaned.
        const form = new FormData()
        form.append('file', file)
        form.append('title', meta.title)
        form.append('artist', meta.artist)
        form.append('duration', String(meta.durationSeconds))
        if (meta.coverBlob) form.append('cover', meta.coverBlob, 'cover.jpg')
        await api('/api/admin/tracks', { method: 'POST', body: form })

        log.push(`ГОТОВО: ${meta.artist} — ${meta.title}`)
      } catch (err) {
        log.push(`ОШИБКА: ${file.name} (${(err as Error).message}) — попробуй загрузить ещё раз`)
      }
    }

    setResults(log)
    setUploading(false)
    reload()
  }

  async function handleDelete(trackId: string) {
    // The backend removes the track, its playlist entry and its files.
    try {
      await api(`/api/admin/tracks/${trackId}`, { method: 'DELETE' })
    } catch (err) {
      setResults([`ОШИБКА УДАЛЕНИЯ: ${(err as Error).message}`])
    }
    reload()
  }

  async function handleToggle(trackId: string, isEnabled: boolean) {
    try {
      await api(`/api/admin/tracks/${trackId}`, { method: 'PATCH', body: { isEnabled: !isEnabled } })
    } catch (err) {
      setResults([`ОШИБКА: ${(err as Error).message}`])
    }
    reload()
  }

  // Sends the whole new order at once; the backend renumbers 1..N atomically.
  async function commitOrder(orderedIds: string[]) {
    try {
      await api('/api/admin/order', { method: 'PUT', body: { ids: orderedIds } })
    } catch (err) {
      setResults([`ОШИБКА СОРТИРОВКИ: ${(err as Error).message}`])
    }
    reload()
  }

  // Fisher-Yates — every permutation of the current order is equally
  // likely, including "barely changed" ones; nothing here nudges it
  // toward a more "shuffled-looking" result, same as a real shuffle.
  async function handleShuffle() {
    // A confirm gate, on top of the button itself being tucked into the
    // header (away from the upload/reorder flow most taps happen in) —
    // this reorders the entire live rotation, not something to trigger by
    // a stray tap.
    if (!window.confirm('Перемешать порядок всех треков в эфире? Отменить это будет нельзя.')) return
    setShuffling(true)
    const ids = entries.map((e) => e.track.id)
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[ids[i], ids[j]] = [ids[j], ids[i]]
    }
    await commitOrder(ids)
    setShuffling(false)
  }

  // Reorders the local drag preview based on whatever's currently under
  // the given viewport point — shared between real pointermove events and
  // the auto-scroll loop below, which needs to keep re-deriving this even
  // while the pointer itself sits still (the page is moving under it).
  function updateDragOrderFromPoint(clientX: number, clientY: number) {
    const draggingId = draggingIdRef.current
    if (!draggingId) return

    const overEl = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>('[data-track-id]')
    const overId = overEl?.dataset.trackId
    if (!overId || overId === draggingId) return

    setDragOrderIds((prev) => {
      if (!prev) return prev
      const from = prev.indexOf(draggingId)
      const to = prev.indexOf(overId)
      if (from === -1 || to === -1 || from === to) return prev
      const next = [...prev]
      next.splice(from, 1)
      next.splice(to, 0, draggingId)
      return next
    })
  }

  // Holding the drag near the top/bottom edge of the screen scrolls the
  // page — without this, a long library was only reorderable within
  // whatever happened to already be on screen, since setPointerCapture +
  // touch-action: none (on .drag-handle) deliberately block the browser's
  // own scroll-while-touching during a drag, and there was nothing to
  // scroll it back. Runs every animation frame for the drag's whole
  // duration (cheap: a couple of comparisons when not near an edge) rather
  // than only on pointermove, because pointermove stops firing the moment
  // the finger itself stops moving — exactly the "held at the edge"
  // case this exists for.
  const AUTO_SCROLL_EDGE_PX = 72
  const AUTO_SCROLL_MAX_PX_PER_FRAME = 16

  function autoScrollTick() {
    const pointer = dragPointerRef.current
    if (!pointer || !draggingIdRef.current) {
      autoScrollRafRef.current = null
      return
    }
    const viewportHeight = window.innerHeight
    let dy = 0
    if (pointer.y < AUTO_SCROLL_EDGE_PX) {
      dy = -AUTO_SCROLL_MAX_PX_PER_FRAME * (1 - pointer.y / AUTO_SCROLL_EDGE_PX)
    } else if (pointer.y > viewportHeight - AUTO_SCROLL_EDGE_PX) {
      dy = AUTO_SCROLL_MAX_PX_PER_FRAME * (1 - (viewportHeight - pointer.y) / AUTO_SCROLL_EDGE_PX)
    }
    if (dy !== 0) {
      window.scrollBy(0, dy)
      updateDragOrderFromPoint(pointer.x, pointer.y)
    }
    autoScrollRafRef.current = requestAnimationFrame(autoScrollTick)
  }

  // Pointer Events (not the old HTML5 drag-and-drop attribute this
  // replaced) so dragging by the handle works on touch, not just mouse —
  // native `draggable` never fires on mobile browsers at all.
  function handleHandlePointerDown(e: ReactPointerEvent, trackId: string) {
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    draggingIdRef.current = trackId
    dragPointerRef.current = { x: e.clientX, y: e.clientY }
    setDragOrderIds(entries.map((en) => en.track.id))
    if (autoScrollRafRef.current === null) {
      autoScrollRafRef.current = requestAnimationFrame(autoScrollTick)
    }
  }

  function handleHandlePointerMove(e: ReactPointerEvent) {
    if (!draggingIdRef.current) return
    dragPointerRef.current = { x: e.clientX, y: e.clientY }
    updateDragOrderFromPoint(e.clientX, e.clientY)
  }

  function handleHandlePointerUp() {
    const finalOrder = dragOrderIds
    draggingIdRef.current = null
    dragPointerRef.current = null
    setDragOrderIds(null)
    if (finalOrder) commitOrder(finalOrder)
  }

  const visibleEntries = dragOrderIds
    ? dragOrderIds.map((id) => entries.find((e) => e.track.id === id)).filter((e): e is PlaylistEntry => !!e)
    : entries

  // "В ротации" reflects what's actually broadcasting right now (enabled
  // tracks only) — computed from data already on hand rather than a
  // second fetch, since `entries` here already includes every track
  // (admins need to see and re-enable disabled ones too).
  const rotationEntries = entries.filter((e) => e.track.isEnabled)

  const isShuffleAdmin = getTelegramUserId() === SHUFFLE_ADMIN_TELEGRAM_ID

  return (
    <div className="admin-library">
      <div className="admin-library__header">
        <h2>БИБЛИОТЕКА</h2>
        {isShuffleAdmin && (
          <button
            type="button"
            className="admin-library__shuffle-button"
            onClick={handleShuffle}
            disabled={shuffling || entries.length < 2}
            aria-label="Перемешать плейлист"
            title="Перемешать плейлист"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="16 3 21 3 21 8" />
              <line x1="4" y1="20" x2="21" y2="3" />
              <polyline points="21 16 21 21 16 21" />
              <line x1="15" y1="15" x2="21" y2="21" />
              <line x1="4" y1="4" x2="9" y2="9" />
            </svg>
          </button>
        )}
      </div>

      <p className="admin-library__rotation-summary">
        В ЭФИРЕ 24/7 • {rotationEntries.length} треков в ротации •{' '}
        {formatDuration(rotationEntries.reduce((sum, e) => sum + e.track.durationSeconds, 0))}
      </p>

      <label
        htmlFor={FILE_INPUT_ID}
        className={`admin-library__upload-button${uploading ? ' is-disabled' : ''}`}
      >
        {uploading ? 'ЗАГРУЖАЮ...' : 'ВЫБРАТЬ ФАЙЛЫ'}
      </label>
      <input
        id={FILE_INPUT_ID}
        className="admin-library__file-input"
        type="file"
        accept="audio/mpeg,audio/mp4,audio/wav"
        multiple
        disabled={uploading}
        onChange={(e) => handleFiles(e.target.files)}
      />
      <ul className="admin-library__results">
        {results.map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ul>

      <ul className="admin-library__list" ref={listRef}>
        {visibleEntries.map((entry) => (
          <li
            key={entry.track.id}
            data-track-id={entry.track.id}
            className={dragOrderIds && draggingIdRef.current === entry.track.id ? 'is-dragging' : ''}
          >
            <div className="admin-library__row">
              <span
                className="drag-handle"
                onPointerDown={(e) => handleHandlePointerDown(e, entry.track.id)}
                onPointerMove={handleHandlePointerMove}
                onPointerUp={handleHandlePointerUp}
                onPointerCancel={handleHandlePointerUp}
              >
                ≡
              </span>
              <span className="admin-library__label">
                {entry.position}. {entry.track.artist} — {entry.track.title}
              </span>
            </div>
            <div className="admin-library__actions">
              <button onClick={() => handleToggle(entry.track.id, entry.track.isEnabled)}>
                {entry.track.isEnabled ? 'Выключить' : 'Включить'}
              </button>
              <button onClick={() => handleDelete(entry.track.id)}>Удалить</button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
