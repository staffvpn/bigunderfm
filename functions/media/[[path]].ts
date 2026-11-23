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
  ASSETS: { fetch(input: Request | string): Promise<Response> }
}

/**
 * Tracks with a voice intro baked in live in the site's own static files
 * (public/intro, built by scripts/bake_intros.py), not in R2. They are served
 * here so the player keeps one media URL scheme and gets Range support, which
 * iOS needs to play audio at all.
 */
async function serveIntro(ctx: { request: Request; env: Env }, key: string): Promise<Response> {
  const name = key.slice('intro/'.length)
  if (!/^[A-Za-z0-9-]+\.mp3$/.test(name)) return new Response('not found', { status: 404 })
  const asset = await ctx.env.ASSETS.fetch(new URL('/intro/' + name, ctx.request.url).toString())
  if (!asset.ok) return new Response('not found', { status: 404 })
  const buf = await asset.arrayBuffer()
  const size = buf.byteLength
  const headers = new Headers({
    'Content-Type': 'audio/mpeg',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=86400',
    'Access-Control-Allow-Origin': '*',
  })
  const m = /^bytes=(\d*)-(\d*)$/.exec(ctx.request.headers.get('range') ?? '')
  if (m && (m[1] || m[2])) {
    let start: number
    let end: number
    if (!m[1]) {
      start = Math.max(size - Number(m[2]), 0)
      end = size - 1
    } else {
      start = Number(m[1])
      end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
    }
    if (start >= size || start > end) {
      headers.set('Content-Range', `bytes */${size}`)
      return new Response(null, { status: 416, headers })
    }
    headers.set('Content-Range', `bytes ${start}-${end}/${size}`)
    headers.set('Content-Length', String(end - start + 1))
    return new Response(buf.slice(start, end + 1), { status: 206, headers })
  }
  headers.set('Content-Length', String(size))
  return new Response(buf, { status: 200, headers })
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
  if (key.startsWith('intro/')) return serveIntro(ctx, key)

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
