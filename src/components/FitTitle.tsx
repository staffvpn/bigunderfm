import { useLayoutEffect, useRef } from 'react'

// A show name kept on one line, as on bigunder.ru: it starts at the size the
// stylesheet gives it and steps down only as far as needed to fit the row.
const MIN_PX = 14

export function FitTitle({ text, className }: { text: string; className: string }) {
  const ref = useRef<HTMLSpanElement>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const fit = () => {
      el.style.fontSize = ''
      let size = parseFloat(getComputedStyle(el).fontSize)
      while (el.scrollWidth > el.clientWidth && size > MIN_PX) {
        size -= 1
        el.style.fontSize = `${size}px`
      }
    }
    fit()
    // Webfonts can arrive after the first layout and change the width.
    document.fonts?.ready.then(fit)
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [text])

  return (
    <span ref={ref} className={`${className} fit-title`}>
      {text}
    </span>
  )
}
