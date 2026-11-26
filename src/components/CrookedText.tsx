/**
 * Text whose letters each lean and sit a little off the line, like type set by
 * hand (the Labil Grotesk specimen look). The tilt comes from the text itself,
 * so the same words always lean the same way.
 */
function seeded(text: string): () => number {
  let h = 2166136261
  for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507)
    h = Math.imul(h ^ (h >>> 13), 3266489909)
    return ((h ^= h >>> 16) >>> 0) / 4294967296
  }
}

export function CrookedText({ text, tilt = 4, lift = 0.04 }: { text: string; tilt?: number; lift?: number }) {
  const rnd = seeded(text)
  return (
    <span className="crooked" aria-label={text}>
      {[...text].map((ch, i) => {
        if (ch === ' ') return <span key={i} aria-hidden="true"> </span>
        const rot = (rnd() * 2 - 1) * tilt
        const dy = (rnd() * 2 - 1) * lift
        return (
          <span key={i} aria-hidden="true" className="crooked__ch" style={{ transform: `translateY(${dy.toFixed(3)}em) rotate(${rot.toFixed(2)}deg)`, animationDelay: `${i * 35}ms` }}>
            {ch}
          </span>
        )
      })}
    </span>
  )
}
