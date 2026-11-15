import { useEffect, useRef, useState } from 'react'
import '@fontsource/archivo-black/latin-400.css'

// The greeting: BIG, UNDER, FM typed letter by letter, the text always
// stretched to fill the whole screen edge to edge, white on the station blue.
// Then the blue folds down into the "Слушать" button.
const FRAMES = ['B', 'BI', 'BIG', 'U', 'UN', 'UND', 'UNDE', 'UNDER', 'F', 'FM']
const FRAME_MS = 100
const HOLD_MS = 350
const MIN_SHOWN_MS = FRAMES.length * FRAME_MS + HOLD_MS
const LEAVE_MS = 550
const FONT = '"Archivo Black", "Inter Tight", Arial, sans-serif'
const BLUE = '#1f2bff'

function draw(canvas: HTMLCanvasElement, text: string) {
  const dpr = Math.min(window.devicePixelRatio || 1, 3)
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  if (canvas.width !== Math.round(w * dpr)) canvas.width = Math.round(w * dpr)
  if (canvas.height !== Math.round(h * dpr)) canvas.height = Math.round(h * dpr)
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.fillStyle = BLUE
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  if (!text) return
  ctx.font = `200px ${FONT}`
  ctx.textBaseline = 'alphabetic'
  const m = ctx.measureText(text)
  const left = m.actualBoundingBoxLeft
  const tw = left + m.actualBoundingBoxRight
  const top = m.actualBoundingBoxAscent
  const th = top + m.actualBoundingBoxDescent
  // A thin margin like the reference, then stretch the letters to fill the rest.
  const pad = Math.round(Math.min(w, h) * 0.035) * dpr
  const sx = (canvas.width - pad * 2) / tw
  const sy = (canvas.height - pad * 2) / th
  ctx.setTransform(sx, 0, 0, sy, pad + left * sx, pad + top * sy)
  ctx.fillStyle = '#ffffff'
  ctx.fillText(text, 0, 0)
}

export function Splash({ ready }: { ready: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [step, setStep] = useState(0)
  const [started, setStarted] = useState(false)
  const [minPassed, setMinPassed] = useState(false)
  const [gone, setGone] = useState(false)
  const [fold, setFold] = useState<React.CSSProperties | undefined>()

  // Start once the font is in (or after a short wait), so the first letter is already the right one.
  useEffect(() => {
    let alive = true
    const go = () => alive && setStarted(true)
    Promise.race([document.fonts?.load(`200px ${FONT}`) ?? Promise.resolve(), new Promise((r) => setTimeout(r, 400))]).then(go, go)
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    if (!started) return
    const timers = [
      ...FRAMES.map((_, i) => setTimeout(() => setStep(i), i * FRAME_MS)),
      setTimeout(() => setMinPassed(true), MIN_SHOWN_MS),
    ]
    return () => timers.forEach(clearTimeout)
  }, [started])

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas) draw(canvas, started ? FRAMES[step] : '')
  }, [step, started])

  useEffect(() => {
    const redraw = () => canvasRef.current && draw(canvasRef.current, started ? FRAMES[step] : '')
    window.addEventListener('resize', redraw)
    return () => window.removeEventListener('resize', redraw)
  }, [step, started])

  const leaving = ready && minPassed
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
  return (
    <div className={`bfm-splash${leaving ? ' is-leaving' : ''}`} style={leaving ? fold : undefined} aria-hidden="true">
      <canvas ref={canvasRef} className="bfm-splash__canvas" />
    </div>
  )
}
