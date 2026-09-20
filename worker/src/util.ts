export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-internal-secret',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Max-Age': '86400',
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Constant-time string comparison for secrets. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function safeExtension(filename: string | undefined): string {
  if (!filename) return ''
  const match = filename.match(/\.([a-zA-Z0-9]+)$/)
  return match ? `.${match[1].toLowerCase()}` : ''
}

/** R2 key for an uploaded track. Never embeds the original name (spaces / non-ASCII). */
export function buildTrackKey(filename: string | undefined): string {
  return `${crypto.randomUUID()}${safeExtension(filename)}`
}

/** Exact audio Content-Type for an extension, or null if the format is not allowed. */
export function audioContentType(filename: string | undefined, fallbackMime?: string): string | null {
  switch (safeExtension(filename)) {
    case '.mp3':
      return 'audio/mpeg'
    case '.wav':
      return 'audio/wav'
    case '.m4a':
    case '.mp4':
      return 'audio/mp4'
  }
  if (fallbackMime === 'audio/mpeg' || fallbackMime === 'audio/mp4' || fallbackMime === 'audio/wav') return fallbackMime
  return null
}

export function stripExtension(filename: string): string {
  const lastDot = filename.lastIndexOf('.')
  return lastDot > 0 ? filename.slice(0, lastDot) : filename
}

export function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} ГБ`
  return `${mb.toFixed(0)} МБ`
}
