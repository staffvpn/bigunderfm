// The live air as short HLS files, relayed from the broadcast server. Listeners
// whose network or VPN cannot open the server itself play these instead of the
// direct stream - ordinary small files, which Cloudflare carries reliably.
const ORIGIN = 'https://195-208-124-129.sslip.io/hls'

export const onRequestGet = async ({ params }: { params: { path?: string | string[] } }): Promise<Response> => {
  const name = Array.isArray(params.path) ? params.path.join('/') : (params.path ?? '')
  const playlist = /^[\w-]+\.m3u8$/.test(name)
  const segment = /^[\w-]+\.ts$/.test(name)
  if (!playlist && !segment) return new Response('not found', { status: 404 })
  let upstream: Response
  try {
    upstream = await fetch(`${ORIGIN}/${name}`, (segment ? { cf: { cacheEverything: true, cacheTtl: 120 } } : { cache: 'no-store' }) as RequestInit)
  } catch {
    return new Response('stream offline', { status: 503 })
  }
  if (!upstream.ok) return new Response('not found', { status: upstream.status === 404 ? 404 : 503 })
  return new Response(upstream.body, {
    headers: {
      'Content-Type': playlist ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
      'Cache-Control': playlist ? 'no-store' : 'public, max-age=120',
      'Access-Control-Allow-Origin': '*',
    },
  })
}
