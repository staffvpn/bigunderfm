import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { sendHeart, subscribeHearts } from '../lib/presence'

// Hearts, in the bigunder.ru look: a debossed button and plain white hearts
// floating up from it.
// Your taps float right away; hearts from everyone else listening arrive in
// small batches and float up the same way.

const MAX_ON_SCREEN = 30
// A big batch from others still shows as a short burst, not a flood.
const MAX_PER_BATCH = 8
const FLOAT_MS = 2600

interface Floater {
  id: number
  x: number
  drift: number
  size: number
  delay: number
  mine: boolean
}

let nextId = 1

const HEART_PATH =
  'M12 21s-7.5-4.6-9.6-9.3C.9 8.4 2.6 4.5 6.3 4.1c2.2-.2 3.9 1 5.7 3.1 1.8-2.1 3.5-3.3 5.7-3.1 3.7.4 5.4 4.3 3.9 7.6C19.5 16.4 12 21 12 21z'

function WhiteHeart({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d={HEART_PATH} fill="#ffffff" stroke="rgba(0, 0, 0, 0.08)" strokeWidth="0.6" />
    </svg>
  )
}

export function HeartReactions() {
  const [floaters, setFloaters] = useState<Floater[]>([])
  const [pressed, setPressed] = useState(false)
  const pressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function spawn(count: number, mine: boolean) {
    const fresh: Floater[] = Array.from({ length: count }, (_, i) => ({
      id: nextId++,
      x: (Math.random() - 0.5) * 24,
      drift: (Math.random() - 0.5) * 70,
      size: mine ? 30 : 18 + Math.random() * 12,
      delay: mine ? 0 : i * 140 + Math.random() * 120,
      mine,
    }))
    setFloaters((prev) => [...prev, ...fresh].slice(-MAX_ON_SCREEN))
    const ids = new Set(fresh.map((f) => f.id))
    const longest = Math.max(...fresh.map((f) => f.delay)) + FLOAT_MS
    setTimeout(() => setFloaters((prev) => prev.filter((f) => !ids.has(f.id))), longest)
  }

  useEffect(() => subscribeHearts((n) => spawn(Math.min(n, MAX_PER_BATCH), false)), [])

  useEffect(
    () => () => {
      if (pressTimerRef.current) clearTimeout(pressTimerRef.current)
    },
    [],
  )

  function handleTap() {
    sendHeart()
    spawn(1, true)
    navigator.vibrate?.(8)
    setPressed(true)
    if (pressTimerRef.current) clearTimeout(pressTimerRef.current)
    pressTimerRef.current = setTimeout(() => setPressed(false), 900)
  }

  return (
    <div className="hearts">
      <div className="hearts__floaters" aria-hidden="true">
        {floaters.map((f) => (
          <span
            key={f.id}
            className={`hearts__floater${f.mine ? ' is-mine' : ''}`}
            style={
              {
                '--x': `${f.x}px`,
                '--drift': `${f.drift}px`,
                animationDelay: `${f.delay}ms`,
                animationDuration: `${FLOAT_MS}ms`,
              } as CSSProperties
            }
          >
            <WhiteHeart size={f.size} />
          </span>
        ))}
      </div>
      <button
        type="button"
        className={`hearts__button${pressed ? ' is-pressed' : ''}`}
        onClick={handleTap}
        aria-label="Отправить сердечко в эфир"
      >
        <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
          <path d={HEART_PATH} fill={pressed ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.4" />
        </svg>
      </button>
    </div>
  )
}
