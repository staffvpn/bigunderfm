import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { supabase } from '../lib/supabase'
import { fetchPlaylist, type PlaylistEntry } from '../lib/tracks'
import { audioContentType, buildTrackFilePath } from '../lib/storagePath'
import { formatDuration } from '../lib/format'

const FILE_INPUT_ID = 'admin-library-file-input'

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

  async function reload() {
    // includeDisabled: the admin must still see (and be able to re-enable)
    // disabled tracks, and reorder renumbering must cover every row.
    setEntries(await fetchPlaylist({ includeDisabled: true }))
  }

  useEffect(() => {
    reload()
  }, [])

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return
    setUploading(true)
    const log: string[] = []

    // Loaded on demand so the ID3 parser is not bundled into the listener's
    // initial download — only an admin who actually uploads ever fetches it.
    const { extractTrackMetadata } = await import('../lib/metadata')

    const { data: existing } = await supabase
      .from('playlist_items')
      .select('position')
      .order('position', { ascending: false })
      .limit(1)
    let nextPosition = (existing?.[0]?.position ?? 0) + 1

    for (const file of Array.from(files)) {
      // Tracked so the catch block can roll back whatever this attempt
      // already created — otherwise a failure partway through (a dropped
      // connection mid-upload on a big file over mobile data, a DB error)
      // leaves an orphaned Storage object that's uploaded but never shows
      // up anywhere, silently eating into the project's storage quota
      // forever with no way to notice from inside the app.
      let uploadedFilePath: string | null = null
      let uploadedCoverPath: string | null = null
      let insertedTrackId: string | null = null

      try {
        const meta = await extractTrackMetadata(file)

        // A zero-duration track occupies no slice of the virtual timeline, so
        // computeCurrentPosition can never land on it and it would silently
        // become unplayable dead weight in the loop. Reject it up front.
        if (meta.durationSeconds <= 0) {
          log.push(`ОШИБКА: ${file.name} (не удалось определить длительность)`)
          continue
        }

        const filePath = buildTrackFilePath(file.name)

        const { error: uploadError } = await supabase.storage
          .from('tracks')
          .upload(filePath, file, { contentType: audioContentType(file.name, file.type) })
        if (uploadError) throw uploadError
        uploadedFilePath = filePath

        let coverPath: string | null = null
        if (meta.coverBlob) {
          coverPath = `${crypto.randomUUID()}.jpg`
          const { error: coverError } = await supabase.storage.from('covers').upload(coverPath, meta.coverBlob)
          if (coverError) throw coverError
          uploadedCoverPath = coverPath
        }

        const { data: trackRow, error: insertError } = await supabase
          .from('tracks')
          .insert({
            title: meta.title,
            artist: meta.artist,
            file_path: filePath,
            cover_path: coverPath,
            duration_seconds: meta.durationSeconds,
            file_size_bytes: file.size,
          })
          .select('id')
          .single()
        if (insertError) throw insertError
        insertedTrackId = trackRow.id

        const { error: playlistError } = await supabase.from('playlist_items').insert({
          track_id: trackRow.id,
          position: nextPosition++,
        })
        if (playlistError) throw playlistError

        log.push(`ГОТОВО: ${meta.artist} — ${meta.title}`)
      } catch (err) {
        if (insertedTrackId) {
          await supabase.from('tracks').delete().eq('id', insertedTrackId)
        }
        if (uploadedFilePath) {
          await supabase.storage.from('tracks').remove([uploadedFilePath])
        }
        if (uploadedCoverPath) {
          await supabase.storage.from('covers').remove([uploadedCoverPath])
        }
        log.push(`ОШИБКА: ${file.name} (${(err as Error).message}) — попробуй загрузить ещё раз`)
      }
    }

    setResults(log)
    setUploading(false)
    reload()
  }

  async function handleDelete(trackId: string) {
    // Deleting the row alone leaves the actual audio (and cover, if any)
    // sitting in Storage forever — it's never referenced again, but never
    // freed either, silently eating into the project's storage quota.
    const entry = entries.find((e) => e.track.id === trackId)
    await supabase.from('tracks').delete().eq('id', trackId)
    if (entry) {
      await supabase.storage.from('tracks').remove([entry.track.filePath])
      if (entry.track.coverPath) {
        await supabase.storage.from('covers').remove([entry.track.coverPath])
      }
    }
    reload()
  }

  async function handleToggle(trackId: string, isEnabled: boolean) {
    await supabase.from('tracks').update({ is_enabled: !isEnabled }).eq('id', trackId)
    reload()
  }

  // Renumbers the ENTIRE list to 1..N in the given order — position has no
  // UNIQUE constraint specifically so this is safe (see 0001_init.sql):
  // any transient duplicate mid-loop self-heals once the loop finishes,
  // and ordering only ever reads via ORDER BY position.
  async function commitOrder(orderedIds: string[]) {
    const failures: string[] = []
    for (let i = 0; i < orderedIds.length; i++) {
      const { error } = await supabase
        .from('playlist_items')
        .update({ position: i + 1 })
        .eq('track_id', orderedIds[i])
      if (error) {
        const entry = entries.find((e) => e.track.id === orderedIds[i])
        failures.push(`ОШИБКА СОРТИРОВКИ: ${entry?.track.title ?? orderedIds[i]} (${error.message})`)
      }
    }
    if (failures.length > 0) {
      setResults(failures)
    }
    reload()
  }

  // Fisher-Yates — every permutation of the current order is equally
  // likely, including "barely changed" ones; nothing here nudges it
  // toward a more "shuffled-looking" result, same as a real shuffle.
  async function handleShuffle() {
    setShuffling(true)
    const ids = entries.map((e) => e.track.id)
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[ids[i], ids[j]] = [ids[j], ids[i]]
    }
    await commitOrder(ids)
    setShuffling(false)
  }

  // Pointer Events (not the old HTML5 drag-and-drop attribute this
  // replaced) so dragging by the handle works on touch, not just mouse —
  // native `draggable` never fires on mobile browsers at all.
  function handleHandlePointerDown(e: ReactPointerEvent, trackId: string) {
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    draggingIdRef.current = trackId
    setDragOrderIds(entries.map((en) => en.track.id))
  }

  function handleHandlePointerMove(e: ReactPointerEvent) {
    const draggingId = draggingIdRef.current
    if (!draggingId) return

    const overEl = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-track-id]')
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

  function handleHandlePointerUp() {
    const finalOrder = dragOrderIds
    draggingIdRef.current = null
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

  return (
    <div className="admin-library">
      <h2>БИБЛИОТЕКА</h2>

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
      <button
        type="button"
        className="admin-library__shuffle-button"
        onClick={handleShuffle}
        disabled={shuffling || entries.length < 2}
      >
        {shuffling ? 'ПЕРЕМЕШИВАЮ...' : '🔀 ПЕРЕМЕШАТЬ'}
      </button>
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
