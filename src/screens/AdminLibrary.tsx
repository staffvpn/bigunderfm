import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { extractTrackMetadata } from '../lib/metadata'
import { fetchPlaylist, type PlaylistEntry } from '../lib/tracks'

export function AdminLibrary() {
  const [entries, setEntries] = useState<PlaylistEntry[]>([])
  const [uploading, setUploading] = useState(false)
  const [results, setResults] = useState<string[]>([])

  async function reload() {
    setEntries(await fetchPlaylist())
  }

  useEffect(() => {
    reload()
  }, [])

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return
    setUploading(true)
    const log: string[] = []

    const { data: existing } = await supabase
      .from('playlist_items')
      .select('position')
      .order('position', { ascending: false })
      .limit(1)
    let nextPosition = (existing?.[0]?.position ?? 0) + 1

    for (const file of Array.from(files)) {
      try {
        const meta = await extractTrackMetadata(file)
        const filePath = `${crypto.randomUUID()}-${file.name}`

        const { error: uploadError } = await supabase.storage.from('tracks').upload(filePath, file)
        if (uploadError) throw uploadError

        let coverPath: string | null = null
        if (meta.coverBlob) {
          coverPath = `${crypto.randomUUID()}.jpg`
          await supabase.storage.from('covers').upload(coverPath, meta.coverBlob)
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

        await supabase.from('playlist_items').insert({
          track_id: trackRow.id,
          position: nextPosition++,
        })

        log.push(`OK: ${meta.artist} — ${meta.title}`)
      } catch (err) {
        log.push(`FAILED: ${file.name} (${(err as Error).message})`)
      }
    }

    setResults(log)
    setUploading(false)
    reload()
  }

  async function handleDelete(trackId: string) {
    await supabase.from('tracks').delete().eq('id', trackId)
    reload()
  }

  async function handleToggle(trackId: string, isEnabled: boolean) {
    await supabase.from('tracks').update({ is_enabled: !isEnabled }).eq('id', trackId)
    reload()
  }

  async function handleReorder(fromPosition: number, toIndex: number) {
    const moved = entries.find((e) => e.position === fromPosition)
    if (!moved) return

    const reordered = entries.filter((e) => e.position !== fromPosition).sort((a, b) => a.position - b.position)
    reordered.splice(toIndex, 0, moved)

    for (let i = 0; i < reordered.length; i++) {
      await supabase.from('playlist_items').update({ position: i + 1 }).eq('track_id', reordered[i].track.id)
    }
    reload()
  }

  return (
    <div className="admin-library">
      <h2>LIBRARY</h2>
      <input
        type="file"
        accept="audio/mpeg,audio/mp4,audio/wav"
        multiple
        disabled={uploading}
        onChange={(e) => handleFiles(e.target.files)}
      />
      {uploading && <p>Uploading…</p>}
      <ul className="admin-library__results">
        {results.map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ul>

      <ul className="admin-library__list">
        {entries.map((entry, index) => (
          <li
            key={entry.track.id}
            draggable
            onDragStart={(e) => e.dataTransfer.setData('text/plain', String(entry.position))}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => handleReorder(Number(e.dataTransfer.getData('text/plain')), index)}
          >
            <span>
              {entry.position}. {entry.track.artist} — {entry.track.title}
            </span>
            <button onClick={() => handleToggle(entry.track.id, entry.track.isEnabled)}>
              {entry.track.isEnabled ? 'Disable' : 'Enable'}
            </button>
            <button onClick={() => handleDelete(entry.track.id)}>Delete</button>
          </li>
        ))}
      </ul>
    </div>
  )
}
