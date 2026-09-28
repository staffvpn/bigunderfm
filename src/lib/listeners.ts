import { api } from './api'

export interface Listener {
  telegramUserId: number
  name: string | null
  username: string | null
  lastSeenAt: string
  totalSeconds: number
  isAdmin: boolean
}

/** Ping while audio is genuinely playing — see RadioScreen's heartbeat
    effect for the exact condition. Best-effort: a failure here (no
    Telegram session, network blip) never affects playback, so callers
    don't need to handle the error. */
export async function sendListenHeartbeat(): Promise<void> {
  try {
    await api('/api/listen/heartbeat', { method: 'POST' })
  } catch {
    // best-effort
  }
}

/** Admin "Слушатели" list — everyone who has ever logged in, with their
    cumulative listening time, sorted by that time (most engaged first). */
export async function fetchListeners(): Promise<Listener[]> {
  try {
    const data = await api<{ listeners: Listener[] }>('/api/admin/listeners')
    return data.listeners
  } catch (err) {
    console.error('fetchListeners failed', err)
    return []
  }
}
