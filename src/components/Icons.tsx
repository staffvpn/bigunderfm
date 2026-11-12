const HEART = 'M10 16.5S1.5 11.6 1.5 5.9A4.2 4.2 0 0 1 10 4.2a4.2 4.2 0 0 1 8.5 1.7C18.5 11.6 10 16.5 10 16.5z'

export function HeartIcon({ filled, size = 20 }: { filled?: boolean; size?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size * 0.9} viewBox="0 0 20 18" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2">
      <path d={HEART} />
    </svg>
  )
}

export function PlayIcon({ size = 26 }: { size?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size * 1.1} viewBox="0 0 18 20">
      <path d="M1 1l16 9-16 9z" fill="currentColor" />
    </svg>
  )
}

export function PauseIcon({ size = 26 }: { size?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size * 1.1} viewBox="0 0 18 20">
      <path d="M2 1h5v18H2zM11 1h5v18h-5z" fill="currentColor" />
    </svg>
  )
}
