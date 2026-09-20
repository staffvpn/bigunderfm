import { api } from './api'

export interface HourlyOpens {
  hour: number
  count: number
}

export interface AdminStats {
  peaks: { day: number; week: number; month: number }
  hourlyOpens: HourlyOpens[]
  totalOpens: number
  storageUsedBytes: number
  trackCount: number
  rotationSeconds: number
  /** Clients that currently have the app open. */
  online: number
}

// R2's free allowance; the backend sums track sizes, so this is approximate
// (covers are tiny). The bot's /status reads the real bucket size.
export const STORAGE_LIMIT_BYTES = 10 * 1024 * 1024 * 1024

/** Everything the "Управление" tab shows besides live Icecast data. Hour buckets are in the caller's timezone. */
export async function fetchAdminStats(): Promise<AdminStats | null> {
  try {
    const tz = -new Date().getTimezoneOffset()
    return await api<AdminStats>(`/api/admin/stats?tz=${tz}`)
  } catch (err) {
    console.error('fetchAdminStats failed', err)
    return null
  }
}
