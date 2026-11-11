// Live stream through Cloudflare: some listeners' networks (or VPN exits)
// cannot reach the broadcast server's own address, but pages.dev is reachable.
const ORIGIN = 'https://195-208-124-129.sslip.io'

export const onRequestGet = async ({ request }: { request: Request }): Promise<Response> => {
  const upstream = await fetch(`${ORIGIN}/radio`, {
    signal: request.signal,
    headers: { 'Icy-MetaData': '0', 'Accept-Encoding': 'identity' },
    cf: { cacheTtl: 0, cacheEverything: false },
  } as RequestInit)
  if (!upstream.ok || !upstream.body) return new Response('stream offline', { status: 503 })
  // Pump chunk by chunk so every piece is flushed to the listener as it arrives.
  const { readable, writable } = new TransformStream()
  const writer = writable.getWriter()
  const reader = upstream.body.getReader()
  ;(async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        await writer.write(value)
      }
      await writer.close()
    } catch {
      try {
        await writer.abort()
      } catch {
        // listener already gone
      }
    }
  })()
  return new Response(readable, {
    headers: {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-store, no-transform',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no',
    },
  })
}
