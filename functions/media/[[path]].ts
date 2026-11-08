// Serves library files from R2 on the app's own domain (bigunderfm.pages.dev).
// The public r2.dev URL isn't reliably reachable from Russia, while pages.dev
// is, so the fallback player (used when the VPS is down) reads tracks here.
// Supports Range requests so the player can seek into the current track.

interface R2Range {
  offset?: number
  length?: number
  suffix?: number
}
interface R2ObjectBody {
  body: ReadableStream
  size: number
  etag: string
  httpEtag: string
  range?: R2Range
  httpMetadata?: { contentType?: string }
}
interface R2Bucket {
  get(key: string, options?: { range?: Headers | R2Range }): Promise<R2ObjectBody | null>
}
interface Env {
  MEDIA: R2Bucket
}

function contentTypeFor(key: string, stored?: string): string {
  if (stored) return stored
  const ext = key.split('.').pop()?.toLowerCase()
  if (ext === 'mp3') return 'audio/mpeg'
  if (ext === 'm4a' || ext === 'aac') return 'audio/mp4'
  if (ext === 'ogg') return 'audio/ogg'
  if (ext === 'wav') return 'audio/wav'
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'png') return 'image/png'
  if (ext === 'webp') return 'image/webp'
  return 'application/octet-stream'
}

export const onRequestGet = async (ctx: { request: Request; env: Env; params: { path?: string | string[] } }) => {
  const parts = ctx.params.path
  const key = Array.isArray(parts) ? parts.map(decodeURIComponent).join('/') : decodeURIComponent(parts ?? '')
  if (!key) return new Response('not found', { status: 404 })

  const rangeHeader = ctx.request.headers.get('range')
  const obj = await ctx.env.MEDIA.get(key, rangeHeader ? { range: ctx.request.headers } : undefined)
  if (!obj) return new Response('not found', { status: 404 })

  const headers = new Headers({
    'Content-Type': contentTypeFor(key, obj.httpMetadata?.contentType),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=86400',
    ETag: obj.httpEtag,
    'Access-Control-Allow-Origin': '*',
  })

  if (rangeHeader && obj.range) {
    const r = obj.range
    let start: number
    let end: number
    if (r.suffix !== undefined) {
      start = Math.max(obj.size - r.suffix, 0)
      end = obj.size - 1
    } else {
      start = r.offset ?? 0
      end = r.length !== undefined ? start + r.length - 1 : obj.size - 1
    }
    headers.set('Content-Range', `bytes ${start}-${end}/${obj.size}`)
    headers.set('Content-Length', String(end - start + 1))
    return new Response(obj.body, { status: 206, headers })
  }

  headers.set('Content-Length', String(obj.size))
  return new Response(obj.body, { status: 200, headers })
}

export const onRequestHead = async (ctx: { request: Request; env: Env; params: { path?: string | string[] } }) => {
  const res = await onRequestGet({ ...ctx, request: new Request(ctx.request.url) })
  return new Response(null, { status: res.status, headers: res.headers })
}
