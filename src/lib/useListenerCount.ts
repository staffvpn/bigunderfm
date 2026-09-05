import { useEffect, useState } from 'react'
import { supabase } from './supabase'

/**
 * Reads the live listener count off the same 'radio-room' presence channel
 * RadioScreen tracks itself into — this hook only reads the synced
 * presence state, it never calls channel.track() itself, so opening this
 * (e.g. from the admin Controls tab) never inflates the count with a
 * non-listening viewer.
 */
export function useListenerCount(): number {
  const [count, setCount] = useState(1)

  useEffect(() => {
    const channel = supabase.channel('radio-room').on('presence', { event: 'sync' }, () => {
      setCount(Math.max(1, Object.keys(channel.presenceState()).length))
    })
    channel.subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [])

  return count
}
