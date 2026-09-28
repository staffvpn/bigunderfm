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

export interface TelegramProfile {
  firstName: string | null
  lastName: string | null
  username: string | null
}

export interface VerifyResult {
  valid: boolean
  telegramUserId: number | null
  profile: TelegramProfile | null
}

const INVALID: VerifyResult = { valid: false, telegramUserId: null, profile: null }

export async function verifyInitData(
  initData: string,
  botToken: string,
  nowSeconds: number = Date.now() / 1000,
): Promise<VerifyResult> {
  const params = new URLSearchParams(initData)
  const hash = params.get('hash')
  if (!hash) return INVALID
  params.delete('hash')

  const authDate = Number(params.get('auth_date'))
  if (!authDate || nowSeconds - authDate > MAX_INIT_DATA_AGE_SECONDS) return INVALID

  const dataCheckString = Array.from(params.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')

  const secretKey = await hmac(enc.encode('WebAppData'), botToken)
  const computed = toHex(await hmac(secretKey, dataCheckString))
  if (computed !== hash) return INVALID

  const userJson = params.get('user')
  let telegramUserId: number | null = null
  let profile: TelegramProfile | null = null
  try {
    if (userJson) {
      const user = JSON.parse(userJson)
      telegramUserId = Number(user.id)
      profile = {
        firstName: typeof user.first_name === 'string' ? user.first_name : null,
        lastName: typeof user.last_name === 'string' ? user.last_name : null,
        username: typeof user.username === 'string' ? user.username : null,
      }
    }
  } catch {
    telegramUserId = null
    profile = null
  }
  const valid = telegramUserId !== null && Number.isFinite(telegramUserId)
  return { valid, telegramUserId, profile: valid ? profile : null }
}
