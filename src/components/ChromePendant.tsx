import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import front from '../assets/pendant/pendant-front.webp'
import side from '../assets/pendant/pendant-side.webp'
import mask from '../assets/pendant/pendant.webp'
import { getTelegramWebApp } from '../lib/telegram'

// The chrome BIGUNDER plate from bigunder.ru, built the same way as on the
// site: a stack of side layers gives it thickness, a light band slides
// across as it turns, sparks flash where the light hits. Here it follows the
// phone's tilt (Telegram's own orientation API, so it works on iPhone too,
// where the browser one needs a permission prompt), can be turned with a
// finger, sways a little on its own, and breathes while the radio plays.

const SIDE_LAYERS = 8
const LAYER_STEP_PX = 0.45
const SPARKS: [number, number][] = [
  [12, 10],
  [47, 30],
  [83, 16],
  [66, 78],
]
// Resting angle: slightly turned, so it reads as an object, not a flat logo.
const REST_Y = -0.18
const MAX_TURN = 0.6

interface TelegramOrientation {
  isStarted: boolean
  beta: number | null
  gamma: number | null
  start(params: { refresh_rate?: number }, cb?: (ok: boolean) => void): void
  stop(cb?: (ok: boolean) => void): void
}

type TelegramWithOrientation = {
  DeviceOrientation?: TelegramOrientation
  isVersionAtLeast?: (v: string) => boolean
  onEvent?: (event: string, cb: () => void) => void
  offEvent?: (event: string, cb: () => void) => void
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

export function ChromePendant({ playing }: { playing: boolean }) {
  const twistRef = useRef<HTMLDivElement>(null)
  const glintRef = useRef<HTMLElement>(null)
  const shadowRef = useRef<HTMLDivElement>(null)
  const sparkRefs = useRef<(HTMLElement | null)[]>([])
  // Where the tilt / finger wants the plate to point (radians).
  const aimRef = useRef({ y: 0, x: 0 })
  const dragRef = useRef<{ x: number; y: number; startY: number; startX: number } | null>(null)

  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let y = 0
    let x = 0
    let vy = 0
    let vx = 0
    let raf = 0
    const t0 = performance.now()

    const draw = () => {
      const ty = REST_Y + y
      if (twistRef.current) twistRef.current.style.transform = `rotateY(${ty.toFixed(4)}rad) rotateX(${x.toFixed(4)}rad)`
      const band = 0.5 - ty * 1.25 - x * 0.8
      if (glintRef.current) glintRef.current.style.transform = `translateX(${((band - 0.5) * 50).toFixed(2)}%)`
      if (shadowRef.current) {
        shadowRef.current.style.transform = `translateX(${(Math.sin(ty) * -6).toFixed(2)}%) scaleX(${(Math.cos(ty) * 0.9 + 0.1).toFixed(3)})`
      }
      sparkRefs.current.forEach((el, i) => {
        if (!el) return
        const e = Math.exp(-(((band - (1 - SPARKS[i][0] / 100) * 0.5 - 0.25) / 0.028) ** 2))
        el.style.opacity = e.toFixed(3)
        el.style.transform = `scale(${(0.6 + e * 0.7).toFixed(3)}) rotate(${(45 * e).toFixed(1)}deg)`
      })
    }

    const loop = (now: number) => {
      const drag = dragRef.current
      // A slow idle sway on top of the aim, so it is never quite still.
      const sway = reduce ? 0 : Math.sin((now - t0) / 2600) * 0.12
      const targetY = drag ? aimRef.current.y : aimRef.current.y + sway
      const targetX = aimRef.current.x
      // Heavy spring: it lags behind the hand a little, like a real weight.
      vy += (targetY - y) * 0.03 - vy * 0.16
      vx += (targetX - x) * 0.03 - vx * 0.16
      y += vy
      x += vx
      draw()
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)

    // Tilt: Telegram's API first (no permission prompt on iPhone), the
    // browser's deviceorientation as a fallback (Android browsers).
    const tg = getTelegramWebApp() as unknown as TelegramWithOrientation | null
    const orientation = tg?.isVersionAtLeast?.('8.0') ? tg.DeviceOrientation : undefined
    const fromTelegram = () => {
      if (dragRef.current || !orientation) return
      const gamma = orientation.gamma ?? 0
      const beta = orientation.beta ?? 0
      aimRef.current = { y: clamp(gamma * 0.9, -MAX_TURN, MAX_TURN), x: clamp((beta - 0.9) * -0.35, -0.25, 0.25) }
    }
    const fromBrowser = (e: DeviceOrientationEvent) => {
      if (dragRef.current || e.gamma === null || e.beta === null) return
      const gamma = (e.gamma * Math.PI) / 180
      const beta = (e.beta * Math.PI) / 180
      aimRef.current = { y: clamp(gamma * 0.9, -MAX_TURN, MAX_TURN), x: clamp((beta - 0.9) * -0.35, -0.25, 0.25) }
    }
    if (!reduce) {
      if (orientation && tg?.onEvent) {
        orientation.start({ refresh_rate: 50 })
        tg.onEvent('deviceOrientationChanged', fromTelegram)
      } else {
        window.addEventListener('deviceorientation', fromBrowser)
      }
    }

    return () => {
      cancelAnimationFrame(raf)
      if (orientation && tg?.offEvent) {
        tg.offEvent('deviceOrientationChanged', fromTelegram)
        orientation.stop()
      }
      window.removeEventListener('deviceorientation', fromBrowser)
    }
  }, [])

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { x: e.clientX, y: e.clientY, startY: aimRef.current.y, startX: aimRef.current.x }
  }
  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const d = dragRef.current
    if (!d) return
    aimRef.current = {
      y: clamp(d.startY + (e.clientX - d.x) / 120, -0.8, 0.8),
      x: clamp(d.startX - (e.clientY - d.y) / 300, -0.3, 0.3),
    }
  }
  function onPointerUp() {
    dragRef.current = null
    // Let go: it swings back toward wherever the tilt says.
    aimRef.current = { y: 0, x: 0 }
  }

  return (
    <div
      className={`chrome-pendant${playing ? ' is-playing' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      aria-label="BIGUNDER Saint-Petersburg"
      role="img"
    >
      <div className="chrome-pendant__shadow" ref={shadowRef} />
      <div className="chrome-pendant__breath">
        <div className="chrome-pendant__twist" ref={twistRef}>
          {Array.from({ length: SIDE_LAYERS }, (_, i) => (
            <img
              key={i}
              className="chrome-pendant__layer"
              src={side}
              alt=""
              draggable={false}
              style={{ transform: `translateZ(${(-(i + 1) * LAYER_STEP_PX).toFixed(1)}px)` }}
            />
          ))}
          <img
            className="chrome-pendant__layer chrome-pendant__layer--back"
            src={side}
            alt=""
            draggable={false}
            style={{ transform: `translateZ(${(-(SIDE_LAYERS + 1) * LAYER_STEP_PX).toFixed(1)}px) rotateY(180deg)` }}
          />
          <div className="chrome-pendant__front">
            <img className="chrome-pendant__layer" src={front} alt="" draggable={false} />
            <div className="chrome-pendant__glint" style={{ WebkitMaskImage: `url(${mask})`, maskImage: `url(${mask})` }}>
              <i ref={glintRef} />
            </div>
            {SPARKS.map(([left, top], i) => (
              <i
                key={i}
                className="chrome-pendant__spark"
                style={{ left: `${left}%`, top: `${top}%` }}
                ref={(el) => {
                  sparkRefs.current[i] = el
                }}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
