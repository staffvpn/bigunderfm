// Verifies Telegram Mini App initData (same algorithm the old Supabase telegram-auth function used).
const MAX_INIT_DATA_AGE_SECONDS = 86400
const enc = new TextEncoder()

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return crypto.subtle.sign('HMAC', k, enc.encode(data))
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export async function verifyInitData(
  initData: string,
  botToken: string,
  nowSeconds: number = Date.now() / 1000,
): Promise<{ valid: boolean; telegramUserId: number | null }> {
  const params = new URLSearchParams(initData)
  const hash = params.get('hash')
  if (!hash) return { valid: false, telegramUserId: null }
  params.delete('hash')

  const authDate = Number(params.get('auth_date'))
  if (!authDate || nowSeconds - authDate > MAX_INIT_DATA_AGE_SECONDS) return { valid: false, telegramUserId: null }

  const dataCheckString = Array.from(params.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')

  const secretKey = await hmac(enc.encode('WebAppData'), botToken)
  const computed = toHex(await hmac(secretKey, dataCheckString))
  if (computed !== hash) return { valid: false, telegramUserId: null }

  const userJson = params.get('user')
  let telegramUserId: number | null = null
  try {
    telegramUserId = userJson ? Number(JSON.parse(userJson).id) : null
  } catch {
    telegramUserId = null
  }
  return { valid: telegramUserId !== null && Number.isFinite(telegramUserId), telegramUserId }
}
