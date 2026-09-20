import { API_URL } from './api'

// Every client keeps one WebSocket open to the backend's presence object; the
// admin dashboard's "Открыли приложение" number is simply how many sockets are
// open. Reconnects with a growing delay if the connection drops.
const PING_INTERVAL_MS = 25_000
const MAX_RECONNECT_DELAY_MS = 30_000

let started = false
let attempts = 0

function connect(): void {
  let ws: WebSocket
  try {
    ws = new WebSocket(`${API_URL.replace(/^http/, 'ws')}/api/presence`)
  } catch {
    scheduleReconnect()
    return
  }

  let pingTimer: ReturnType<typeof setInterval> | null = null

  ws.onopen = () => {
    attempts = 0
    pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send('ping')
    }, PING_INTERVAL_MS)
  }
  ws.onclose = () => {
    if (pingTimer) clearInterval(pingTimer)
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
