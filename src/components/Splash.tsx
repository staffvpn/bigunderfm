import { useEffect, useState } from 'react'

// The greeting: the station's header already in place on a black screen, its
// facts ticking in as table rows while a blue bar tunes in; then the black
// rolls up into the header and the app is simply there underneath.

const ROWS: [string, string][] = [
  ['EST.', '2019'],
  ['FROM', 'MOSCOW / SAINT PETERSBURG'],
  ['SOUND', 'HIP-HOP / BOOM BAP / LO-FI'],
  ['ON AIR', '24/7'],
]
const MIN_SHOWN_MS = 1900
const LEAVE_MS = 750

export function Splash({ ready }: { ready: boolean }) {
  const [minPassed, setMinPassed] = useState(false)
  const [gone, setGone] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => setMinPassed(true), MIN_SHOWN_MS)
    return () => clearTimeout(timer)
  }, [])

  const leaving = ready && minPassed
  useEffect(() => {
    if (!leaving) return
    const timer = setTimeout(() => setGone(true), LEAVE_MS)
    return () => clearTimeout(timer)
  }, [leaving])

  if (gone) return null
  return (
    <div className={`bfm-splash${leaving ? ' is-leaving' : ''}`} aria-hidden="true">
      <div className="bfm__head">
        BIGUNDER FM
        <br />
        Independent Hip-Hop Radio
      </div>
      <div className="bfm-splash__rows">
        {ROWS.map(([key, value], i) => (
          <div className="bfm-splash__row" key={key} style={{ animationDelay: `${150 + i * 170}ms` }}>
            <span>{key}</span>
            <span>{value}</span>
          </div>
        ))}
      </div>
      <div className="bfm-splash__word">
        <span>BIG</span>
        <span>UNDER</span>
      </div>
      <div className="bfm-splash__tune">
        <span>Tuning in</span>
        <div className="bfm-splash__bar" />
      </div>
    </div>
  )
}
