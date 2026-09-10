import { supabase } from './supabase'

const BUCKETS = ['tracks', 'covers'] as const

// Supabase's free plan caps total Storage (across every bucket in the
// project combined) at 1 GB — not configurable, this is the plan limit
// itself, not something we set. Upgrading to Pro raises it to 100 GB.
export const FREE_TIER_STORAGE_BYTES = 1024 * 1024 * 1024

export interface StorageUsage {
  usedBytes: number
  limitBytes: number
}

async function bucketSizeBytes(bucket: string): Promise<number> {
  let total = 0
  let offset = 0
  const pageSize = 1000
  // Paginates rather than assuming everything fits in one list() call —
  // safe as the library grows well past whatever fits on a single page.
  for (;;) {
    const { data, error } = await supabase.storage.from(bucket).list('', { limit: pageSize, offset })
    if (error || !data) break
    for (const obj of data) {
      total += obj.metadata?.size ?? 0
    }
    if (data.length < pageSize) break
    offset += pageSize
  }
  return total
}

export async function fetchStorageUsage(): Promise<StorageUsage> {
  const sizes = await Promise.all(BUCKETS.map(bucketSizeBytes))
  return {
    usedBytes: sizes.reduce((a, b) => a + b, 0),
    limitBytes: FREE_TIER_STORAGE_BYTES,
  }
}
