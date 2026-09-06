import { useLayoutEffect, type RefObject } from 'react'

interface FitTextOptions {
  min?: number
  max?: number
  step?: number
}

/**
 * Shrinks an element's font-size (starting from `max`) until its content
 * actually fits its own box height, instead of a fixed size/clamp() that
 * either wastes space for a short title or clips letters for a long one
 * (the previous approach — see git history — clipped mid-glyph once a
 * title grew past what the fixed clamp() assumed). Re-measures whenever
 * `text` changes or the window resizes (mobile browser chrome
 * showing/hiding changes the viewport height without any text change).
 */
export function useFitText(
  ref: RefObject<HTMLElement>,
  text: string,
  { min = 28, max = 140, step = 2 }: FitTextOptions = {},
) {
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return

    function fit() {
      if (!el) return
      let size = max
      el.style.fontSize = `${size}px`
      // scrollHeight > clientHeight means the text is taller than the box
      // actually has room for — shrink until it isn't, or we hit the floor.
      while (size > min && el.scrollHeight > el.clientHeight) {
        size -= step
        el.style.fontSize = `${size}px`
      }
    }

    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [ref, text, min, max, step])
}
