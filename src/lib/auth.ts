import { api, setAuthToken } from './api'
import { getInitData } from './telegram'

export interface AuthResult {
  isAdmin: boolean
}

/**
 * Signs in through the backend: it verifies Telegram's signed initData and
 * answers with whether this user is an admin plus a short-lived session token.
 * Outside Telegram (no initData) the app simply runs as a plain listener.
 */
export async function authenticate(): Promise<AuthResult> {
  const initData = getInitData()
  if (!initData) {
    return { isAdmin: false }
  }

  try {
    const data = await api<{ isAdmin: boolean; token?: string }>('/api/auth/telegram', {
      method: 'POST',
      body: { initData },
    })
    setAuthToken(data.token ?? null)
    return { isAdmin: Boolean(data.isAdmin) }
  } catch (err) {
    console.error('telegram auth failed', err)
    return { isAdmin: false }
  }
}
