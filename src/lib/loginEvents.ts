import { supabase } from './supabase'

export interface HourlyOpens {
  hour: number
  count: number
}

// A few thousand rows is already generous for this project's actual
// traffic (280 total as of writing) — caps the payload without needing
// real pagination for what's meant to be a rough "when do people show up"
// histogram, not an exact audit trail.
const MAX_EVENTS = 5000

/**
 * Buckets every recorded app-open (login_events, written server-side by
 * telegram-auth on each launch) by hour of day, in the CALLER's own local
 * timezone — there's no per-listener timezone stored, so this is only
 * ever a proxy for "the admin's local time of day", not each individual
 * listener's. Fine for a single-timezone audience; would need actual
 * per-event offsets to do better.
 */
export async function fetchHourlyOpens(): Promise<HourlyOpens[]> {
  const counts = new Array(24).fill(0)
  const { data } = await supabase.from('login_events').select('created_at').limit(MAX_EVENTS)
  for (const row of data ?? []) {
    const hour = new Date(row.created_at).getHours()
    counts[hour]++
  }
  return counts.map((count, hour) => ({ hour, count }))
}
