// Minimal HS256 JWT: the app's own session token, replacing Supabase Auth.
export interface Claims {
  sub: string // Telegram user id
  admin: boolean
  exp: number // seconds since epoch
}

const enc = new TextEncoder()

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let s = ''
  for (const b of arr) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromB64url(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)
  const bin = atob(padded)
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

async function hmacKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage])
}

export async function signJwt(claims: Claims, secret: string): Promise<string> {
  const header = b64url(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))
  const payload = b64url(enc.encode(JSON.stringify(claims)))
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), enc.encode(`${header}.${payload}`))
  return `${header}.${payload}.${b64url(sig)}`
}

export async function verifyJwt(token: string, secret: string): Promise<Claims | null> {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [header, payload, sig] = parts
  try {
    const ok = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret, 'verify'),
      fromB64url(sig),
      enc.encode(`${header}.${payload}`),
    )
    if (!ok) return null
    const claims = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as Claims
    if (!claims.exp || claims.exp < Date.now() / 1000) return null
    return claims
  } catch {
    return null
  }
}
