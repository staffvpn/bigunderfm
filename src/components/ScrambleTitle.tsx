import { useLayoutEffect, useRef } from 'react'

// The artist's name on air, kept on one line. When the track changes, the
// letters run through random characters and lock into the new name from
// left to right, like a departures board finding its line.
const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZАБВГДЕЖЗИКЛМНОПРСТУФХЦЧШЭЮЯ0123456789#/+'
const DURATION_MS = 750

export function ScrambleTitle({ text, className, min = 14 }: { text: string; className: string; min?: number }) {
  const ref = useRef<HTMLSpanElement>(null)
  const shownRef = useRef<string | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    // Size for the final name first, so nothing jumps while letters run.
    const fit = () => {
      const keep = el.textContent
      el.textContent = text
      el.style.fontSize = ''
      let size = parseFloat(getComputedStyle(el).fontSize)
      while (el.scrollWidth > el.clientWidth && size > min) {
        size -= 1
        el.style.fontSize = `${size}px`
      }
      el.textContent = keep
    }
    fit()
    document.fonts?.ready.then(fit)
    window.addEventListener('resize', fit)

    const first = shownRef.current === null
    shownRef.current = text
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (first || reduce || document.visibilityState !== 'visible' || text.length > 60) {
      el.textContent = text
      return () => window.removeEventListener('resize', fit)
    }
    const chars = [...text]
    el.classList.remove('is-changing')
    void el.offsetWidth
    el.classList.add('is-changing')
    const start = performance.now()
    let frame = 0
    let raf = 0
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / DURATION_MS)
      // Each letter locks a little after the one before it.
      const locked = Math.floor(p * chars.length * 1.15)
      if (frame++ % 2 === 0 || p === 1) {
        el.textContent = chars
          .map((c, i) => (i < locked || c === ' ' ? c : GLYPHS[Math.floor(Math.random() * GLYPHS.length)]))
          .join('')
      }
      if (p < 1) raf = requestAnimationFrame(tick)
      else el.textContent = text
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      el.textContent = text
      window.removeEventListener('resize', fit)
    }
  }, [text, min])

  return <span ref={ref} className={`${className} fit-title`} aria-label={text} />
}
