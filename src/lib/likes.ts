import { api } from './api'

export interface LikeState {
  count: number
  liked: boolean
}

// One like per person per track. Inside Telegram the backend knows who is
// asking; on the web this phone gets its own random id.
export function deviceId(): string {
  try {
    let id = localStorage.getItem('bfm_device')
    if (!id) {
      id = crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
      localStorage.setItem('bfm_device', id)
    }
    return id
  } catch {
    return ''
  }
}

export function fetchLike(trackId: string): Promise<LikeState> {
  return api<LikeState>(`/api/likes?trackId=${encodeURIComponent(trackId)}&device=${encodeURIComponent(deviceId())}`)
}

export function sendLike(trackId: string): Promise<LikeState> {
  return api<LikeState>('/api/likes', { method: 'POST', body: { trackId, device: deviceId() } })
}
