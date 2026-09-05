interface OnAirBadgeProps {
  isPlaying: boolean
}

export function OnAirBadge({ isPlaying }: OnAirBadgeProps) {
  return (
    <div className={`on-air-badge ${isPlaying ? 'on-air-badge--live' : ''}`}>
      <span className="on-air-badge__dot" />
      {isPlaying ? 'В ЭФИРЕ' : 'НЕ В ЭФИРЕ'}
    </div>
  )
}
