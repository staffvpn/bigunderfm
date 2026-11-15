import { useEffect, useRef, useState } from 'react'

// The greeting, in the app's own hand: the black header drops in, BIGUNDER FM
// decodes letter by letter like a track name, a tuning needle runs across a
// dial of 88-108 and locks, the blue square starts to blink: on air. Then the
// white falls away and the app is underneath, header already in place.
const MIN_SHOWN_MS = 2100
const LEAVE_MS = 600
const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#/+'
const TITLE = 'BIGUNDER FM'

function useDecode(text: string, delayMs: number, durationMs: number): string {
  const [shown, setShown] = useState(() => text.replace(/\S/g, ' '))
  const raf = useRef(0)
  useEffect(() => {
    const chars = [...text]
    let start = 0
    const tick = (now: number) => {
      if (!start) start = now
      const p = Math.min(1, (now - start) / durationMs)
      const locked = Math.floor(p * chars.length * 1.1)
      setShown(chars.map((c, i) => (i < locked || c === ' ' ? c : p === 0 ? ' ' : GLYPHS[Math.floor(Math.random() * GLYPHS.length)])).join(''))
      if (p < 1) raf.current = requestAnimationFrame(tick)
    }
    const timer = setTimeout(() => {
      raf.current = requestAnimationFrame(tick)
    }, delayMs)
    return () => {
      clearTimeout(timer)
      cancelAnimationFrame(raf.current)
    }
  }, [text, delayMs, durationMs])
  return shown
}

// Needle path over time: runs across, overshoots, settles on the station.
const NEEDLE: [number, number][] = [
  [0, 0],
  [0.55, 0.82],
  [0.75, 0.66],
  [0.88, 0.71],
  [1, 0.695],
]
const ease = (x: number) => 1 - (1 - x) ** 3
function needleAt(p: number): number {
  for (let i = 1; i < NEEDLE.length; i++) {
    const [t1, v1] = NEEDLE[i]
    const [t0, v0] = NEEDLE[i - 1]
    if (p <= t1) return v0 + (v1 - v0) * ease((p - t0) / (t1 - t0))
  }
  return NEEDLE[NEEDLE.length - 1][1]
}

/** Needle position 0..1, moving from delayMs for durationMs. */
function useNeedle(delayMs: number, durationMs: number): number {
  const [pos, setPos] = useState(0)
  useEffect(() => {
    let raf = 0
    let start = 0
    const tick = (now: number) => {
      if (!start) start = now
      const p = Math.min(1, (now - start) / durationMs)
      setPos(needleAt(p))
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    const timer = setTimeout(() => {
      raf = requestAnimationFrame(tick)
    }, delayMs)
    return () => {
      clearTimeout(timer)
      cancelAnimationFrame(raf)
    }
  }, [delayMs, durationMs])
  return pos
}

export function Splash({ ready }: { ready: boolean }) {
  const [minPassed, setMinPassed] = useState(false)
  const [gone, setGone] = useState(false)
  const title = useDecode(TITLE, 250, 700)
  const needle = useNeedle(350, 1400)
  const freq = (88 + needle * 20).toFixed(1)

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
  const ticks = Array.from({ length: 41 }, (_, i) => i)
  return (
    <div className={`bfm-splash${leaving ? ' is-leaving' : ''}`} aria-hidden="true">
      <div className="bfm-splash__head">
        <span>{title}</span>
        <span className="bfm-splash__sub">Independent Hip-Hop Radio</span>
      </div>
      <div className="bfm-splash__body">
        <div className="bfm-splash__freq">
          <span>{freq}</span>
          <small>FM</small>
        </div>
        <div className="bfm-splash__dial">
          <div className="bfm-splash__ticks">
            {ticks.map((i) => (
              <i key={i} className={i % 5 === 0 ? 'is-major' : ''} />
            ))}
          </div>
          <div className="bfm-splash__scale">
            <span>88</span>
            <span>93</span>
            <span>98</span>
            <span>103</span>
            <span>108</span>
          </div>
          <div className="bfm-splash__needle" style={{ left: `${needle * 100}%` }} />
        </div>
        <div className="bfm-splash__onair">
          <span className="bfm__live" />
          <span>В эфире</span>
        </div>
      </div>
    </div>
  )
}
