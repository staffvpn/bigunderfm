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
