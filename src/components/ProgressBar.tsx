interface ProgressBarProps {
  offsetSeconds: number
  durationSeconds: number
}

export function ProgressBar({ offsetSeconds, durationSeconds }: ProgressBarProps) {
  const percent = durationSeconds > 0 ? Math.min(100, (offsetSeconds / durationSeconds) * 100) : 0

  return (
    <div className="progress-bar">
      <div className="progress-bar__track">
        <div className="progress-bar__fill" style={{ width: `${percent}%` }} />
      </div>
      <div className="progress-bar__time">
        <span>{formatTime(offsetSeconds)}</span>
        <span>{formatTime(durationSeconds)}</span>
      </div>
    </div>
  )
}

function formatTime(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(safe / 60)
  const remainder = safe % 60
  return `${minutes}:${remainder.toString().padStart(2, '0')}`
}
