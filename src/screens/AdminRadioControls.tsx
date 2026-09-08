import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { fetchPlaylist, type PlaylistEntry } from '../lib/tracks'
import { useListenerCount } from '../lib/useListenerCount'

// The broadcast is now a real, always-on stream (Icecast + Liquidsoap on
// the VPS) — there's no "pause" concept anymore, same as a real radio
// station never pauses. The only server-side action left is Skip, which
// goes through the radio-skip Edge Function (admin-gated there via
// is_current_user_admin(), same check the old RPCs used) rather than a
// direct RPC, since the actual skip has to reach Liquidsoap's telnet
// control interface on the VPS, not the database.
export function AdminRadioControls() {
  const [entries, setEntries] = useState<PlaylistEntry[]>([])
  const [skipping, setSkipping] = useState(false)
  const [skipError, setSkipError] = useState<string | null>(null)
  const listenerCount = useListenerCount()

  async function reload() {
    setEntries(await fetchPlaylist())
  }

  useEffect(() => {
    reload()
  }, [])

  async function handleSkip() {
    setSkipping(true)
    setSkipError(null)
    try {
      const { data, error } = await supabase.functions.invoke('radio-skip', { method: 'POST' })
      if (error || data?.error) {
        setSkipError(data?.error ?? error?.message ?? 'Не удалось переключить трек')
      }
    } catch (err) {
      setSkipError((err as Error).message)
    } finally {
      setSkipping(false)
    }
  }

  return (
    <div className="admin-radio-controls">
      <h2>ЭФИР</h2>
      <p>Статус: В ЭФИРЕ 24/7</p>
      <p>Слушают: {listenerCount}</p>
      <button onClick={handleSkip} disabled={skipping}>
        {skipping ? 'ПЕРЕКЛЮЧАЮ...' : 'СЛЕДУЮЩИЙ ТРЕК'}
      </button>
      {skipError && <p className="admin-radio-controls__error">{skipError}</p>}
      <ul>
        {entries.map((entry) => (
          <li key={entry.track.id}>
            <span>
              {entry.position}. {entry.track.artist} — {entry.track.title}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
