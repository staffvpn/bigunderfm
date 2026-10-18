import { api } from './api'

// Going live from the admin tab: the phone's microphone is recorded with
// MediaRecorder and streamed over a WebSocket to Liquidsoap's input.harbor on
// the VPS (the "webcast" protocol: a JSON hello, then raw media chunks).
// Liquidsoap mixes the voice over the music, which drops to 20% while anyone
// is live. The session lives at module level, not in a component, so switching
// tabs inside the app doesn't cut the broadcast.

export type LivePhase = 'idle' | 'starting' | 'live' | 'error'

export interface LiveState {
  phase: LivePhase
  slot: string | null
  startedAt: number | null
  error: string | null
  /** 0..1 microphone level, for the meter. */
  level: number
}

interface LiveCredentials {
  url: string
  password: string
  slots: string[]
}

// How long a freshly opened socket must stay open after the hello for the
// slot to count as ours. Liquidsoap closes it right away on a wrong password
// or a mount that already has a host.
const ACCEPT_WAIT_MS = 1500
const CHUNK_MS = 250

let state: LiveState = { phase: 'idle', slot: null, startedAt: null, error: null, level: 0 }
const listeners = new Set<(s: LiveState) => void>()

let socket: WebSocket | null = null
let recorder: MediaRecorder | null = null
let micStream: MediaStream | null = null
let audioCtx: AudioContext | null = null
let meterFrame = 0
let wakeLock: { release(): Promise<void> } | null = null
let stopping = false

function setState(patch: Partial<LiveState>) {
  state = { ...state, ...patch }
  listeners.forEach((l) => l(state))
}

export function getLiveState(): LiveState {
  return state
}

export function subscribeLive(listener: (s: LiveState) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function pickMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4']
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? null
}

function connectSlot(url: string, password: string, mime: string): Promise<WebSocket | null> {
  return new Promise((resolve) => {
    let settled = false
    const ws = new WebSocket(url, 'webcast')
    const done = (result: WebSocket | null) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'hello', data: { mime, user: 'source', password } }))
      setTimeout(() => done(ws.readyState === WebSocket.OPEN ? ws : null), ACCEPT_WAIT_MS)
    }
    ws.onclose = () => done(null)
    ws.onerror = () => done(null)
  })
}

function startMeter(stream: MediaStream) {
  try {
    audioCtx = new AudioContext()
    const analyser = audioCtx.createAnalyser()
    analyser.fftSize = 512
    audioCtx.createMediaStreamSource(stream).connect(analyser)
    const buf = new Uint8Array(analyser.fftSize)
    const tick = () => {
      analyser.getByteTimeDomainData(buf)
      let peak = 0
      for (const v of buf) peak = Math.max(peak, Math.abs(v - 128))
      setState({ level: Math.min(1, peak / 96) })
      meterFrame = requestAnimationFrame(tick)
    }
    tick()
  } catch {
    // The meter is a nice-to-have; broadcasting works without it.
  }
}

function cleanup() {
  cancelAnimationFrame(meterFrame)
  if (recorder && recorder.state !== 'inactive') recorder.stop()
  recorder = null
  micStream?.getTracks().forEach((t) => t.stop())
  micStream = null
  audioCtx?.close().catch(() => {})
  audioCtx = null
  if (socket) {
    socket.onclose = null
    socket.close()
  }
  socket = null
  wakeLock?.release().catch(() => {})
  wakeLock = null
}

export async function startLive(): Promise<void> {
  if (state.phase === 'starting' || state.phase === 'live') return
  stopping = false
  setState({ phase: 'starting', error: null, slot: null, startedAt: null, level: 0 })

  try {
    const recMime = pickMimeType()
    if (!recMime) throw new Error('Этот браузер не умеет записывать звук. Открой приложение в Chrome или Safari.')
    const helloMime = recMime.split(';')[0]

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Нет доступа к микрофону в этом окне. Открой приложение в Chrome или Safari.')
    }
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
    } catch {
      throw new Error('Микрофон не разрешён. Разреши доступ к микрофону и попробуй ещё раз.')
    }

    const creds = await api<LiveCredentials>('/api/admin/live')
    let ws: WebSocket | null = null
    let slot: string | null = null
    for (const s of creds.slots) {
      ws = await connectSlot(`${creds.url}${s}`, creds.password, helloMime)
      if (ws) {
        slot = s
        break
      }
    }
    if (!ws || !slot) throw new Error('Не удалось подключиться к эфиру — все места заняты или сервер недоступен.')
    socket = ws

    ws.onclose = () => {
      if (stopping) return
      cleanup()
      setState({ phase: 'error', error: 'Связь с эфиром оборвалась. Нажми «Выйти в эфир» ещё раз.', level: 0 })
    }

    recorder = new MediaRecorder(micStream, { mimeType: recMime, audioBitsPerSecond: 96_000 })
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0 && socket?.readyState === WebSocket.OPEN) socket.send(e.data)
    }
    recorder.start(CHUNK_MS)
    startMeter(micStream)

    try {
      const nav = navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } }
      wakeLock = (await nav.wakeLock?.request('screen')) ?? null
    } catch {
      wakeLock = null
    }

    setState({ phase: 'live', slot, startedAt: Date.now() })
  } catch (err) {
    cleanup()
    setState({ phase: 'error', error: (err as Error).message, level: 0 })
  }
}

export function stopLive(): void {
  stopping = true
  cleanup()
  setState({ phase: 'idle', slot: null, startedAt: null, error: null, level: 0 })
}
