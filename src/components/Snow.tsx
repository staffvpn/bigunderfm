import { useEffect, useRef } from 'react'

/**
 * Slow, dense, atmospheric snow over the dark top of the main screen (the
 * header and the photo). Three depths: small far flakes, medium ones and a
 * few big soft flakes close to the "lens". It fades out toward the bottom of
 * the photo so it never meets the white part in a hard line.
 *
 * Draws on one canvas with requestAnimationFrame and stops while the page is
 * hidden, so a locked phone spends nothing on it. Touches pass through.
 */

type Layer = { per: number; r: [number, number]; v: [number, number]; a: number; soft: boolean }

// Flakes per 10,000 CSS px² of snowy area, size in CSS px, fall speed in CSS px/s.
const LAYERS: Layer[] = [
  { per: 13, r: [0.9, 1.5], v: [7, 11], a: 0.8, soft: false },
  { per: 6, r: [1.8, 2.8], v: [12, 17], a: 0.85, soft: false },
  { per: 0.9, r: [5.5, 9], v: [21, 28], a: 0.3, soft: true },
]
const FADE = 50 // CSS px at the bottom over which flakes melt away

type Flake = { layer: number; x: number; y0: number; r: number; v: number; ph: number; sway: number; swaySpeed: number }

function sprite(soft: boolean): HTMLCanvasElement {
  const c = document.createElement('canvas')
  const s = 64
  c.width = s
  c.height = s
  const g = c.getContext('2d')!
  const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2)
  gr.addColorStop(0, 'rgba(255,255,255,1)')
  gr.addColorStop(0.45, `rgba(255,255,255,${soft ? 0.5 : 0.9})`)
  gr.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = gr
  g.fillRect(0, 0, s, s)
  return c
}

export function Snow({ until }: { until: React.RefObject<HTMLElement | null> }) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const cv = ref.current
    const target = until.current
    if (!cv || !target) return
    const ctx = cv.getContext('2d')
    if (!ctx) return
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return

    const sprites = LAYERS.map((l) => sprite(l.soft))
    let flakes: Flake[] = []
    let w = 0
    let h = 0
    const dpr = Math.min(window.devicePixelRatio || 1, 2)

    const layout = () => {
      w = cv.parentElement?.clientWidth || target.clientWidth
      h = target.offsetTop + target.offsetHeight
      cv.style.height = `${h}px`
      cv.width = Math.round(w * dpr)
      cv.height = Math.round(h * dpr)
      const area = (w * h) / 10000
      flakes = []
      LAYERS.forEach((l, layer) => {
        const n = Math.round(l.per * area)
        for (let i = 0; i < n; i++) {
          flakes.push({
            layer,
            x: Math.random() * w,
            y0: Math.random() * h,
            r: l.r[0] + Math.random() * (l.r[1] - l.r[0]),
            v: l.v[0] + Math.random() * (l.v[1] - l.v[0]),
            ph: Math.random() * Math.PI * 2,
            sway: 3 + Math.random() * 8,
            swaySpeed: 0.25 + Math.random() * 0.4,
          })
        }
      })
    }

    let raf = 0
    const start = performance.now()
    const draw = (now: number) => {
      const t = (now - start) / 1000
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      for (const f of flakes) {
        const l = LAYERS[f.layer]
        const y = ((f.y0 + t * f.v) % (h + 20)) - 10
        const x = (((f.x + Math.sin(t * f.swaySpeed + f.ph) * f.sway + t * 2) % w) + w) % w
        const edge = Math.min(1, (h - y) / FADE)
        if (edge <= 0) continue
        ctx.globalAlpha = l.a * edge
        const s = f.r * 2.6
        ctx.drawImage(sprites[f.layer], x - s / 2, y - s / 2, s, s)
      }
      ctx.globalAlpha = 1
      raf = requestAnimationFrame(draw)
    }

    const run = () => {
      cancelAnimationFrame(raf)
      if (document.visibilityState === 'visible') raf = requestAnimationFrame(draw)
    }

    layout()
    run()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(layout) : null
    ro?.observe(target)
    document.addEventListener('visibilitychange', run)
    return () => {
      cancelAnimationFrame(raf)
      ro?.disconnect()
      document.removeEventListener('visibilitychange', run)
    }
  }, [until])

  return <canvas ref={ref} className="bfm__snow" aria-hidden="true" />
}
