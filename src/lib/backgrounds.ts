// Any image OR video dropped into src/assets/backgrounds/ is picked up
// automatically on the next build/deploy — import.meta.glob scans the
// folder at build time, so adding more files later needs no code change
// here, only the new files themselves committed into that folder.
export interface BackgroundItem {
  src: string
  type: 'image' | 'video'
}

const imageModules = import.meta.glob('/src/assets/backgrounds/*.{png,jpg,jpeg,webp}', {
  eager: true,
  import: 'default',
}) as Record<string, string>

// mp4/webm cover the two formats every modern mobile browser (including
// Telegram's in-app WebView on iOS/Android) can decode without a plugin —
// no point accepting a format that would just fail to play silently.
const videoModules = import.meta.glob('/src/assets/backgrounds/*.{mp4,webm}', {
  eager: true,
  import: 'default',
}) as Record<string, string>

export const BACKGROUND_ITEMS: BackgroundItem[] = [
  ...Object.values(imageModules).map((src) => ({ src, type: 'image' as const })),
  ...Object.values(videoModules).map((src) => ({ src, type: 'video' as const })),
]

function shuffle<T>(items: T[]): T[] {
  const shuffled = [...items]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled
}

// Shuffle-bag rather than an independent Math.random() pick each time —
// plain independent random CAN and does repeat the same background back-
// to-back or in quick succession purely by chance, which is exactly what
// "random but never repeats" is supposed to rule out for a small curated
// pool. This draws every item once, in a random order (images and videos
// mixed together in the same pool), before any item is allowed to repeat.
let bag: BackgroundItem[] = []
let lastPicked: string | undefined

function refillBag() {
  bag = shuffle(BACKGROUND_ITEMS)
  // A plain per-cycle shuffle can still produce a repeat right at the
  // boundary between cycles (the last draw of one cycle happening to be
  // first draw of the next) — swap it out if so.
  if (bag.length > 1 && bag[bag.length - 1].src === lastPicked) {
    const swapWith = Math.floor(Math.random() * (bag.length - 1))
    ;[bag[bag.length - 1], bag[swapWith]] = [bag[swapWith], bag[bag.length - 1]]
  }
}

export function pickNextBackground(): BackgroundItem | undefined {
  if (BACKGROUND_ITEMS.length === 0) return undefined
  if (bag.length === 0) refillBag()
  const picked = bag.pop()
  lastPicked = picked?.src
  return picked
}
