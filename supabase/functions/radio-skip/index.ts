import { createClient } from 'jsr:@supabase/supabase-js@2'

// Bridges the admin UI to the live broadcast server. The VPS's skip
// endpoint (a tiny HTTP wrapper around Liquidsoap's telnet control
// interface — see /usr/local/bin/skip_bridge.py on 159.194.234.135) is
// guarded by its own shared secret, which must never reach client code —
// that's the whole reason this hop exists instead of the browser calling
// the VPS directly.
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
// Routed through the same HTTPS nginx front-end as the stream itself
// (path /skip-bridge/ -> localhost:8001 on the VPS) rather than a raw
// http://ip:8001 URL — Deno's fetch has no mixed-content restriction the
// way a browser does, so this particular hop didn't strictly need it, but
// keeping one HTTPS origin for everything server-side is simpler to reason
// about and to firewall later if a bare :8001 port ever needs closing off.
const RADIO_SERVER_URL = Deno.env.get('RADIO_SERVER_URL') ?? 'https://159-194-234-135.sslip.io/skip-bridge'
// No tooling on hand to set a custom Function secret for this project, so
// this falls back to a literal matching what's baked into skip-bridge.service
// on the VPS. Edge Function source isn't served to browsers, only readable
// via the Supabase dashboard/CLI by the project owner, so this is no less
// protected than an env var would be here — just swap both sides via
// `supabase secrets set SKIP_BRIDGE_SECRET=...` + updating the systemd unit
// if you want it out of source later.
const SKIP_BRIDGE_SECRET = Deno.env.get('SKIP_BRIDGE_SECRET') || '1a151deb9153bb476555f0ccb2f27bc0f9d0a64204efe342'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS })
  }
  if (req.method !== 'POST') {
    return new Response('method not allowed', { status: 405, headers: CORS_HEADERS })
  }

  // Run the same is_current_user_admin() check the RPC-based controls use,
  // as the calling user — forwarding their JWT through PostgREST rather
  // than trusting anything client-supplied.
  const authHeader = req.headers.get('Authorization') ?? ''
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  })

  const { data: isAdmin, error: authError } = await userClient.rpc('is_current_user_admin')
  if (authError || !isAdmin) {
    return new Response(JSON.stringify({ error: 'not authorized' }), {
      status: 403,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    })
  }

  try {
    const resp = await fetch(`${RADIO_SERVER_URL}/skip`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SKIP_BRIDGE_SECRET}` },
    })
    const body = await resp.text()
    if (!resp.ok) {
      return new Response(JSON.stringify({ error: body || `skip bridge returned ${resp.status}` }), {
        status: 502,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 502,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    })
  }
})
