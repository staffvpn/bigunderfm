// Icecast status (listeners, title) through Cloudflare, cached for a few seconds.
const ORIGIN = 'https://195-208-124-129.sslip.io'

export const onRequestGet = async (): Promise<Response> => {
  try {
    const upstream = await fetch(`${ORIGIN}/status-json.xsl`, { cf: { cacheTtl: 5, cacheEverything: true } } as RequestInit)
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
    })
  } catch {
    return new Response('{}', { status: 503, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } })
  }
}
