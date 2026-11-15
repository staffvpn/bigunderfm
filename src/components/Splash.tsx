import { useEffect, useState } from 'react'

// The greeting: BIG, UNDER, FM fill the screen one word at a time, on a beat,
// then a blue frame says ON AIR and folds down into the place of the
// "Слушать" button, and the app is there.
const BEAT_MS = 300
const FRAMES = ['BIG', 'UNDER', 'FM'] as const
const BLUE_AT = BEAT_MS * FRAMES.length // 900
const MIN_SHOWN_MS = BLUE_AT + 650
const LEAVE_MS = 550

export function Splash({ ready }: { ready: boolean }) {
  const [step, setStep] = useState(0)
  const [minPassed, setMinPassed] = useState(false)
  const [gone, setGone] = useState(false)

  useEffect(() => {
    const timers = [
      ...FRAMES.map((_, i) => setTimeout(() => setStep(i), i * BEAT_MS)),
      setTimeout(() => setStep(FRAMES.length), BLUE_AT),
      setTimeout(() => setMinPassed(true), MIN_SHOWN_MS),
    ]
    return () => timers.forEach(clearTimeout)
  }, [])

  const leaving = ready && minPassed
  const [fold, setFold] = useState<React.CSSProperties | undefined>()
  useEffect(() => {
    if (!leaving) return
    // Fold onto the real "Слушать" button, wherever this screen puts it.
    const button = document.querySelector('.bfm__play')?.getBoundingClientRect()
    if (button && button.height > 0) {
      setFold({ clipPath: `inset(${button.top}px 0 ${Math.max(0, window.innerHeight - button.bottom)}px 0)` })
    }
    const timer = setTimeout(() => setGone(true), LEAVE_MS)
    return () => clearTimeout(timer)
  }, [leaving])

  if (gone) return null
  const onBlue = step >= FRAMES.length
  return (
    <div className={`bfm-splash${onBlue ? ' is-blue' : ''}${leaving ? ' is-leaving' : ''}`} style={leaving ? fold : undefined} aria-hidden="true">
      {!onBlue && (
        <div className="bfm-splash__word" key={step}>
          <span className={`bfm-splash__w bfm-splash__w--${FRAMES[step].toLowerCase()}`}>{FRAMES[step]}</span>
        </div>
      )}
      {onBlue && (
        <div className="bfm-splash__air">
          <span className="bfm__live" />
          <span>В эфире</span>
        </div>
      )}
    </div>
  )
}
