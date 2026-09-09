// Any image dropped into src/assets/backgrounds/ is picked up automatically
// on the next build/deploy — import.meta.glob scans the folder at build
// time, so adding more files later needs no code change here, only the
// new files themselves committed into that folder.
const modules = import.meta.glob('/src/assets/backgrounds/*.{png,jpg,jpeg,webp}', {
  eager: true,
  import: 'default',
}) as Record<string, string>

export const BACKGROUND_IMAGES: string[] = Object.values(modules)

export function pickRandomBackground(): string | undefined {
  if (BACKGROUND_IMAGES.length === 0) return undefined
  return BACKGROUND_IMAGES[Math.floor(Math.random() * BACKGROUND_IMAGES.length)]
}
