/** "1 ч 24 мин", "24 мин", "38 сек" — used for playlist totals and stream uptime. */
export function formatDuration(totalSeconds: number): string {
  const total = Math.max(0, Math.round(totalSeconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60

  if (hours > 0) return `${hours} ч ${minutes} мин`
  if (minutes > 0) return `${minutes} мин`
  return `${seconds} сек`
}

/** Elapsed time since `since`, formatted the same way as formatDuration. */
export function formatElapsedSince(since: Date): string {
  return formatDuration((Date.now() - since.getTime()) / 1000)
}

/** "02:15", "1:04:30" — a single track's own length, clock-style rather
    than the word-based "N мин" format above. */
export function formatClock(totalSeconds: number): string {
  const total = Math.max(0, Math.round(totalSeconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes)
  const ss = String(seconds).padStart(2, '0')
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`
}
