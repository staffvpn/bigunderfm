const HEART = 'M10 16.5S1.5 11.6 1.5 5.9A4.2 4.2 0 0 1 10 4.2a4.2 4.2 0 0 1 8.5 1.7C18.5 11.6 10 16.5 10 16.5z'

/** Winter: the like is a snowflake instead of a heart. Set to false to bring the heart back. */
const WINTER = true
const SNOWFLAKE = 'M10 10L10.00 1.50M10.00 4.80L8.13 2.72M10.00 4.80L11.87 2.72M10 10L2.64 5.75M5.50 7.40L2.76 7.98M5.50 7.40L4.63 4.74M10 10L2.64 14.25M5.50 12.60L4.63 15.26M5.50 12.60L2.76 12.02M10 10L10.00 18.50M10.00 15.20L11.87 17.28M10.00 15.20L8.13 17.28M10 10L17.36 14.25M14.50 12.60L17.24 12.02M14.50 12.60L15.37 15.26M10 10L17.36 5.75M14.50 7.40L15.37 4.74M14.50 7.40L17.24 7.98'

export function SnowflakeIcon({ filled, size = 20 }: { filled?: boolean; size?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={filled ? 2.2 : 1.6} strokeLinecap="round">
      <path d={SNOWFLAKE} />
    </svg>
  )
}

export function HeartIcon({ filled, size = 20 }: { filled?: boolean; size?: number }) {
  if (WINTER) return <SnowflakeIcon filled={filled} size={size + 2} />
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
