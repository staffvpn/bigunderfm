// Live stream through Cloudflare: some listeners' networks cannot reach the
// broadcast server's own address, but pages.dev is reachable for everyone.
const ORIGIN = 'https://195-208-124-129.sslip.io'

export const onRequestGet = async ({ request }: { request: Request }): Promise<Response> => {
  const upstream = await fetch(`${ORIGIN}/radio`, { signal: request.signal, headers: { 'Icy-MetaData': '0' } })
  if (!upstream.ok || !upstream.body) return new Response('stream offline', { status: 503 })
  return new Response(upstream.body, {
    headers: {
      'Content-Type': upstream.headers.get('Content-Type') ?? 'audio/mpeg',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    },
  })
}
