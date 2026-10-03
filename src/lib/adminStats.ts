import { api } from './api'

export interface AdminStats {
  peaks: { day: number; week: number; month: number }
  storageUsedBytes: number
  trackCount: number
  rotationSeconds: number
}

// R2's free allowance; the backend sums track sizes, so this is approximate
// (covers are tiny). The bot's /status reads the real bucket size.
export const STORAGE_LIMIT_BYTES = 10 * 1024 * 1024 * 1024

/** Everything the "Управление" tab shows besides live Icecast data. */
export async function fetchAdminStats(): Promise<AdminStats | null> {
  try {
    return await api<AdminStats>('/api/admin/stats')
  } catch (err) {
    console.error('fetchAdminStats failed', err)
    return null
  }
}
