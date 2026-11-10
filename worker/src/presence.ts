import { DurableObject } from 'cloudflare:workers'
import type { Env } from './env'
import { recordHearts } from './program'

// Hearts are batched: everyone gets one message per window, with the hearts
// everyone else sent in it (their own taps are already shown on their phone).
const HEART_FLUSH_MS = 500
// One message can carry at most this many taps, so nobody floods the room.
const MAX_HEARTS_PER_MESSAGE = 10
const HEART_CREDIT_MS = 60_000

/**
 * Counts how many clients currently have the app open: each client keeps one
 * WebSocket to this single object and the count is the number of open sockets.
 * Uses the hibernation API so idle sockets cost nothing, with an auto-response
 * for "ping" so keep-alives do not wake the object.
 *
 * The same sockets carry listeners' hearts: a client sends "h<n>" for n taps,
 * and every client receives {"h": n} with the hearts the others sent.
 */
export class Presence extends DurableObject<Env> {
  private pendingHearts = new Map<WebSocket, number>()
  private lastCredit = new Map<WebSocket, number>()
  private flushTimer: ReturnType<typeof setTimeout> | null = null

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname.endsWith('/count')) {
      return Response.json({ count: this.ctx.getWebSockets().length })
    }
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 })
    }
    const pair = new WebSocketPair()
    this.ctx.acceptWebSocket(pair[1])
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== 'string' || !message.startsWith('h')) return
    const n = Math.min(MAX_HEARTS_PER_MESSAGE, Math.max(0, Math.trunc(Number(message.slice(1)) || 0)))
    if (!n) return
    this.pendingHearts.set(ws, (this.pendingHearts.get(ws) ?? 0) + n)
    // A pending timer also keeps the object awake until the batch is out.
    this.flushTimer ??= setTimeout(() => this.flushHearts(), HEART_FLUSH_MS)
  }

  private flushHearts(): void {
    this.flushTimer = null
    const batch = this.pendingHearts
    this.pendingHearts = new Map()
    let total = 0
    batch.forEach((n) => (total += n))
    if (!total) return
    // The track on air gets one heart per listener, at most once a minute
    // each (auto-hits): counting people rather than taps keeps one fast
    // thumb from deciding what a hit is.
    const nowMs = Date.now()
    let credited = 0
    batch.forEach((_n, ws) => {
      if (nowMs - (this.lastCredit.get(ws) ?? 0) < HEART_CREDIT_MS) return
      this.lastCredit.set(ws, nowMs)
      credited++
    })
    if (credited) this.ctx.waitUntil(recordHearts(this.env, credited).catch((err) => console.error('recordHearts failed', err)))
    for (const ws of this.ctx.getWebSockets()) {
      const others = total - (batch.get(ws) ?? 0)
      if (!others) continue
      try {
        ws.send(JSON.stringify({ h: others }))
      } catch {
        // closing
      }
    }
  }

  webSocketClose(ws: WebSocket, code: number): void {
    this.lastCredit.delete(ws)
    try {
      ws.close(code === 1005 ? 1000 : code)
    } catch {
      // already closed
    }
  }
}
