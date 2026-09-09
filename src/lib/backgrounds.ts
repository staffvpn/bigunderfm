// Any image dropped into src/assets/backgrounds/ is picked up automatically
// on the next build/deploy — import.meta.glob scans the folder at build
// time, so adding more files later needs no code change here, only the
// new files themselves committed into that folder.
const modules = import.meta.glob('/src/assets/backgrounds/*.{png,jpg,jpeg,webp}', {
  eager: true,
  import: 'default',
}) as Record<string, string>

export const BACKGROUND_IMAGES: string[] = Object.values(modules)

function shuffle<T>(items: T[]): T[] {
  const shuffled = [...items]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled
}

// Shuffle-bag rather than an independent Math.random() pick each time —
// plain independent random CAN and does repeat the same image back-to-
// back or in quick succession purely by chance, which is exactly what
// "random but never repeats" is supposed to rule out for a small curated
// pool. This draws every image once, in a random order, before any image
// is allowed to repeat.
let bag: string[] = []
let lastPicked: string | undefined

function refillBag() {
  bag = shuffle(BACKGROUND_IMAGES)
  // A plain per-cycle shuffle can still produce a repeat right at the
  // boundary between cycles (the last draw of one cycle happening to be
  // first draw of the next) — swap it out if so.
  if (bag.length > 1 && bag[bag.length - 1] === lastPicked) {
    const swapWith = Math.floor(Math.random() * (bag.length - 1))
    ;[bag[bag.length - 1], bag[swapWith]] = [bag[swapWith], bag[bag.length - 1]]
  }
}

export function pickNextBackground(): string | undefined {
  if (BACKGROUND_IMAGES.length === 0) return undefined
  if (bag.length === 0) refillBag()
  lastPicked = bag.pop()
  return lastPicked
}
