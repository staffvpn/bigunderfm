import { api } from './api'

export const DEFAULT_SHOW_NAME = 'LOCAL SELECTS'

/** The small tagline under the header on the radio screen; admin-editable. */
export async function fetchShowName(): Promise<string> {
  try {
    const data = await api<{ name: string }>('/api/show-name')
    return data.name?.trim() || DEFAULT_SHOW_NAME
  } catch {
    return DEFAULT_SHOW_NAME
  }
}

export async function updateShowName(name: string): Promise<{ error: string | null }> {
  try {
    await api('/api/admin/show-name', { method: 'PUT', body: { name } })
    return { error: null }
  } catch (err) {
    return { error: (err as Error).message }
  }
}
