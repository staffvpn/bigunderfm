import { DurableObject } from 'cloudflare:workers'
import type { Env } from './env'

/**
 * Counts how many clients currently have the app open: each client keeps one
 * WebSocket to this single object and the count is the number of open sockets.
 * Uses the hibernation API so idle sockets cost nothing, with an auto-response
 * for "ping" so keep-alives do not wake the object.
 */
export class Presence extends DurableObject<Env> {
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

  webSocketMessage(): void {
    // Only "ping" is ever sent; it is answered by the auto-response.
  }

  webSocketClose(ws: WebSocket, code: number): void {
    try {
      ws.close(code === 1005 ? 1000 : code)
    } catch {
      // already closed
    }
  }
}
