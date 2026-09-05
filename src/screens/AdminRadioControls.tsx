import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { fetchPlaylist, fetchRadioState, type PlaylistEntry } from '../lib/tracks'
import { useListenerCount } from '../lib/useListenerCount'

export function AdminRadioControls() {
  const [entries, setEntries] = useState<PlaylistEntry[]>([])
  const [isPlaying, setIsPlaying] = useState(false)
  const listenerCount = useListenerCount()

  async function reload() {
    setEntries(await fetchPlaylist())
    const state = await fetchRadioState()
    setIsPlaying(state?.isPlaying ?? false)
  }

  useEffect(() => {
    reload()
  }, [])

  async function handlePause() {
    await supabase.rpc('radio_pause')
    reload()
  }

  async function handleResume() {
    await supabase.rpc('radio_resume')
    reload()
  }

  async function handleSkip(position: number) {
    await supabase.rpc('radio_skip_to', { target_position: position })
    reload()
  }

  return (
    <div className="admin-radio-controls">
      <h2>ЭФИР</h2>
      <p>Статус: {isPlaying ? 'ИГРАЕТ' : 'ПАУЗА'}</p>
      <p>Слушают: {listenerCount}</p>
      <button onClick={isPlaying ? handlePause : handleResume}>{isPlaying ? 'ПАУЗА' : 'ЗАПУСТИТЬ'}</button>
      <ul>
        {entries.map((entry) => (
          <li key={entry.track.id}>
            <span>
              {entry.position}. {entry.track.artist} — {entry.track.title}
            </span>
            <button onClick={() => handleSkip(entry.position)}>Включить отсюда</button>
          </li>
        ))}
      </ul>
    </div>
  )
}
