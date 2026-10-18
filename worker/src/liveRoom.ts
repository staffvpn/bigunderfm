import { DurableObject } from 'cloudflare:workers'
import type { Env } from './env'

interface Peer {
  id: string
  name: string
}

/**
 * Signalling for the hosts' own call: while live, each host's phone keeps one
 * WebSocket here and the phones set up WebRTC audio to each other through it,
 * so hosts hear one another in real time (the broadcast itself lags 5–10 s).
 * Only relays messages; no audio passes through. The Worker lets admins in only.
 *
 *   server -> client  {type:'welcome', id, peers:[{id,name}]}
 *                     {type:'join', id, name} / {type:'leave', id}
 *                     {type:'signal', from, data}
 *   client -> server  {type:'signal', to, data}
 */
export class LiveRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  private peers(): { ws: WebSocket; peer: Peer }[] {
    return this.ctx
      .getWebSockets()
      .map((ws) => ({ ws, peer: ws.deserializeAttachment() as Peer | null }))
      .filter((p): p is { ws: WebSocket; peer: Peer } => !!p.peer)
  }

  private send(ws: WebSocket, msg: unknown): void {
    try {
      ws.send(JSON.stringify(msg))
    } catch {
      // closing
    }
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 })
    }
    const name = (new URL(request.url).searchParams.get('name') ?? '').slice(0, 40) || 'Ведущий'
    const others = this.peers()
    const pair = new WebSocketPair()
    const peer: Peer = { id: crypto.randomUUID(), name }
    this.ctx.acceptWebSocket(pair[1])
    pair[1].serializeAttachment(peer)
    this.send(pair[1], { type: 'welcome', id: peer.id, peers: others.map((o) => o.peer) })
    for (const o of others) this.send(o.ws, { type: 'join', ...peer })
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== 'string') return
    const from = ws.deserializeAttachment() as Peer | null
    let msg: { type?: string; to?: string; data?: unknown }
    try {
      msg = JSON.parse(message)
    } catch {
      return
    }
    if (!from || msg.type !== 'signal' || typeof msg.to !== 'string') return
    const target = this.peers().find((p) => p.peer.id === msg.to)
    if (target) this.send(target.ws, { type: 'signal', from: from.id, data: msg.data })
  }

  webSocketClose(ws: WebSocket, code: number): void {
    const gone = ws.deserializeAttachment() as Peer | null
    try {
      ws.close(code === 1005 ? 1000 : code)
    } catch {
      // already closed
    }
    if (!gone) return
    for (const o of this.peers()) {
      if (o.peer.id !== gone.id) this.send(o.ws, { type: 'leave', id: gone.id })
    }
  }

  webSocketError(ws: WebSocket): void {
    this.webSocketClose(ws, 1011)
  }
}
