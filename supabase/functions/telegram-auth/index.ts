import { createClient } from 'jsr:@supabase/supabase-js@2'

const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

async function hmacSha256(key: BufferSource, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data))
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

async function verifyInitData(
  initData: string,
  botToken: string,
): Promise<{ valid: boolean; telegramUserId: number | null }> {
  const params = new URLSearchParams(initData)
  const hash = params.get('hash')
  if (!hash) return { valid: false, telegramUserId: null }
  params.delete('hash')

  const dataCheckString = Array.from(params.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')

  const secretKey = await hmacSha256(new TextEncoder().encode('WebAppData'), botToken)
  const computedHash = toHex(await hmacSha256(secretKey, dataCheckString))

  if (computedHash !== hash) {
    return { valid: false, telegramUserId: null }
  }

  const userJson = params.get('user')
  const telegramUserId = userJson ? JSON.parse(userJson).id : null
  return { valid: true, telegramUserId }
}

Deno.serve(async (req) => {
  try {
    const { initData, userId } = await req.json()

    if (!initData || !userId) {
      return new Response(JSON.stringify({ error: 'initData and userId are required' }), { status: 400 })
    }

    const { valid, telegramUserId } = await verifyInitData(initData, BOT_TOKEN)
    if (!valid || !telegramUserId) {
      return new Response(JSON.stringify({ isAdmin: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

    const { data: adminRow } = await adminClient
      .from('admins')
      .select('telegram_user_id')
      .eq('telegram_user_id', telegramUserId)
      .maybeSingle()

    const isAdmin = Boolean(adminRow)

    if (isAdmin) {
      await adminClient.auth.admin.updateUserById(userId, {
        app_metadata: { is_admin: true },
      })
    }

    return new Response(JSON.stringify({ isAdmin }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error(err)
    return new Response(JSON.stringify({ error: 'internal error' }), { status: 500 })
  }
})
