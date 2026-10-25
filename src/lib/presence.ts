import { API_URL } from './api'

// Every client keeps one WebSocket open to the backend's presence object.
// It also carries hearts: taps are sent in small batches, and the hearts
// other listeners sent come back the same way. Reconnects with a growing
// delay if the connection drops.
const PING_INTERVAL_MS = 25_000
const MAX_RECONNECT_DELAY_MS = 30_000
// Taps are collected for this long and sent as one message.
const HEART_SEND_MS = 300

let started = false
let attempts = 0
let socket: WebSocket | null = null
let unsentHearts = 0
let heartTimer: ReturnType<typeof setTimeout> | null = null
const heartListeners = new Set<(n: number) => void>()

function connect(): void {
  let ws: WebSocket
  try {
    ws = new WebSocket(`${API_URL.replace(/^http/, 'ws')}/api/presence`)
  } catch {
    scheduleReconnect()
    return
  }
  socket = ws

  let pingTimer: ReturnType<typeof setInterval> | null = null

  ws.onopen = () => {
    attempts = 0
    pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send('ping')
    }, PING_INTERVAL_MS)
  }
  ws.onmessage = (e) => {
    if (typeof e.data !== 'string' || e.data === 'pong') return
    try {
      const n = Number((JSON.parse(e.data) as { h?: number }).h)
      if (n > 0) heartListeners.forEach((l) => l(n))
    } catch {
      // not ours
    }
  }
  ws.onclose = () => {
    if (pingTimer) clearInterval(pingTimer)
    if (socket === ws) socket = null
    scheduleReconnect()
  }
  ws.onerror = () => ws.close()
}

function scheduleReconnect(): void {
  const delay = Math.min(1000 * 2 ** attempts, MAX_RECONNECT_DELAY_MS)
  attempts += 1
  setTimeout(connect, delay)
}

export function joinAppPresence(): void {
  if (started) return
  started = true
  connect()
}

/** One tap on the heart. Shown locally right away by the caller. */
export function sendHeart(): void {
  unsentHearts += 1
  heartTimer ??= setTimeout(() => {
    heartTimer = null
    const n = unsentHearts
    unsentHearts = 0
    if (socket?.readyState === WebSocket.OPEN) socket.send(`h${n}`)
  }, HEART_SEND_MS)
}

/** Hearts other listeners sent; called with how many arrived in one batch. */
export function subscribeHearts(listener: (n: number) => void): () => void {
  heartListeners.add(listener)
  return () => {
    heartListeners.delete(listener)
  }
}
