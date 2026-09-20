import { describe, expect, it } from 'vitest'
import { signJwt, verifyJwt } from './jwt'
import { verifyInitData } from './telegramAuth'

const enc = new TextEncoder()

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return crypto.subtle.sign('HMAC', k, enc.encode(data))
}

// Builds initData exactly the way Telegram does, so the verifier is tested against the real algorithm.
async function makeInitData(botToken: string, userId: number, authDate: number): Promise<string> {
  const params = new URLSearchParams({
    auth_date: String(authDate),
    query_id: 'AAH',
    user: JSON.stringify({ id: userId, first_name: 'T' }),
  })
  const dcs = Array.from(params.entries())
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
  const secret = await hmac(enc.encode('WebAppData'), botToken)
  const hash = Array.from(new Uint8Array(await hmac(secret, dcs)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  params.set('hash', hash)
  return params.toString()
}

describe('jwt', () => {
  const exp = Math.floor(Date.now() / 1000) + 600

  it('round-trips valid claims', async () => {
    const token = await signJwt({ sub: '42', admin: true, exp }, 'secret')
    expect(await verifyJwt(token, 'secret')).toEqual({ sub: '42', admin: true, exp })
  })

  it('rejects a wrong secret, a tampered payload and an expired token', async () => {
    const token = await signJwt({ sub: '42', admin: false, exp }, 'secret')
    expect(await verifyJwt(token, 'other')).toBeNull()

    const [h, , s] = token.split('.')
    const forged = btoa(JSON.stringify({ sub: '42', admin: true, exp })).replace(/=+$/, '')
    expect(await verifyJwt(`${h}.${forged}.${s}`, 'secret')).toBeNull()

    const old = await signJwt({ sub: '42', admin: true, exp: Math.floor(Date.now() / 1000) - 5 }, 'secret')
    expect(await verifyJwt(old, 'secret')).toBeNull()
    expect(await verifyJwt('garbage', 'secret')).toBeNull()
  })
})

describe('verifyInitData', () => {
  const now = Math.floor(Date.now() / 1000)

  it('accepts genuine initData and returns the user id', async () => {
    const data = await makeInitData('123:TOKEN', 929887068, now - 10)
    expect(await verifyInitData(data, '123:TOKEN')).toEqual({ valid: true, telegramUserId: 929887068 })
  })

  it('rejects data signed with another bot token', async () => {
    const data = await makeInitData('123:TOKEN', 1, now)
    expect((await verifyInitData(data, '999:OTHER')).valid).toBe(false)
  })

  it('rejects tampered user id, missing hash and stale auth_date', async () => {
    const data = await makeInitData('123:TOKEN', 1, now)
    const tampered = data.replace('%22id%22%3A1', '%22id%22%3A2')
    expect((await verifyInitData(tampered, '123:TOKEN')).valid).toBe(false)
    expect((await verifyInitData('auth_date=1', '123:TOKEN')).valid).toBe(false)
    const stale = await makeInitData('123:TOKEN', 1, now - 2 * 86400)
    expect((await verifyInitData(stale, '123:TOKEN')).valid).toBe(false)
  })
})
