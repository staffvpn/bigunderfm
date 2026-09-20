// Client for the BIGUNDER FM backend (Cloudflare Worker) that replaced Supabase.
export const API_URL: string =
  (import.meta.env.VITE_API_URL as string | undefined) || 'https://bigunderfm-api.fillat0ff321.workers.dev'

let authToken: string | null = null

export function setAuthToken(token: string | null): void {
  authToken = token
}

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

/**
 * JSON request to the backend. Sends the session token when there is one. A
 * FormData body is passed through untouched so the browser sets the multipart
 * boundary itself.
 */
export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = {}
  if (authToken) headers.Authorization = `Bearer ${authToken}`

  let body: BodyInit | undefined
  if (init.body instanceof FormData) {
    body = init.body
  } else if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(init.body)
  }

  const res = await fetch(`${API_URL}${path}`, { method: init.method ?? 'GET', headers, body })
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    throw new ApiError((data as { error?: string } | null)?.error ?? `HTTP ${res.status}`, res.status)
  }
  return data as T
}
