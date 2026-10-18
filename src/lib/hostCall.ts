import { API_URL, getAuthToken } from './api'
import { getTelegramDisplayName } from './telegram'

// The hosts' own call. While live, every host's phone joins one "room" (a
// WebSocket to the backend that only relays setup messages) and gets a direct
// WebRTC audio link to each other host, so they hear one another in real time
// like a phone call — the broadcast itself reaches listeners 5–10 s late.
// The same microphone feeds both the call and the broadcast. Audio goes
// phone-to-phone, or through our TURN relay on the VPS when a mobile network
// won't allow a direct link.

export type CallPeerState = 'connecting' | 'connected' | 'failed'

export interface CallPeer {
  id: string
  name: string
  state: CallPeerState
}

export interface CallState {
  peers: CallPeer[]
  /** The phone blocked playback of the other hosts until the next tap. */
  needsTap: boolean
}

type SignalData = { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit }

interface PeerLink {
  name: string
  pc: RTCPeerConnection
  audio: HTMLAudioElement
  state: CallPeerState
}

const PING_INTERVAL_MS = 25_000
const RECONNECT_DELAY_MS = 2000

let state: CallState = { peers: [], needsTap: false }
const listeners = new Set<(s: CallState) => void>()

let socket: WebSocket | null = null
let pingTimer: ReturnType<typeof setInterval> | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let micStream: MediaStream | null = null
let iceServers: RTCIceServer[] = []
let active = false
const links = new Map<string, PeerLink>()
// <audio> elements unlocked during the "go live" tap: phones only let a page
// start sound from a user gesture, and the other hosts connect later.
const spareAudio: HTMLAudioElement[] = []

function emit() {
  state = {
    ...state,
    peers: [...links].map(([id, l]) => ({ id, name: l.name, state: l.state })),
  }
  listeners.forEach((l) => l(state))
}

export function getCallState(): CallState {
  return state
}

export function subscribeCall(listener: (s: CallState) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function newAudio(): HTMLAudioElement {
  const audio = document.createElement('audio')
  audio.autoplay = true
  audio.setAttribute('playsinline', '')
  return audio
}

/** Call synchronously inside the tap that starts going live. */
export function primeCallAudio(): void {
  while (spareAudio.length < 2) {
    const audio = newAudio()
    audio.play().catch(() => {})
    spareAudio.push(audio)
  }
}

function playAudio(audio: HTMLAudioElement) {
  audio.play().catch(() => {
    state = { ...state, needsTap: true }
    emit()
  })
}

/** For the "turn on the other hosts' sound" button. */
export function resumeCallAudio(): void {
  state = { ...state, needsTap: false }
  links.forEach((l) => playAudio(l.audio))
  emit()
}

function sendSignal(to: string, data: SignalData) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'signal', to, data }))
}

function dropLink(id: string) {
  const link = links.get(id)
  if (!link) return
  link.pc.close()
  link.audio.srcObject = null
  links.delete(id)
  emit()
}

function createLink(id: string, name: string): PeerLink {
  dropLink(id)
  const pc = new RTCPeerConnection({ iceServers })
  const link: PeerLink = { name, pc, audio: spareAudio.pop() ?? newAudio(), state: 'connecting' }
  links.set(id, link)
  micStream?.getAudioTracks().forEach((t) => pc.addTrack(t, micStream!))
  pc.onicecandidate = (e) => {
    if (e.candidate) sendSignal(id, { candidate: e.candidate.toJSON() })
  }
  pc.ontrack = (e) => {
    link.audio.srcObject = e.streams[0] ?? new MediaStream([e.track])
    playAudio(link.audio)
  }
  pc.onconnectionstatechange = () => {
    if (links.get(id) !== link) return
    if (pc.connectionState === 'connected') link.state = 'connected'
    else if (pc.connectionState === 'failed') link.state = 'failed'
    else if (pc.connectionState === 'connecting' || pc.connectionState === 'new') link.state = 'connecting'
    emit()
  }
  emit()
  return link
}

async function callPeer(id: string, name: string) {
  const { pc } = createLink(id, name)
  await pc.setLocalDescription(await pc.createOffer())
  sendSignal(id, { sdp: pc.localDescription!.toJSON() })
}

async function onSignal(from: string, data: SignalData) {
  if (data.sdp?.type === 'offer') {
    // A host who joined after us is calling.
    const { pc } = createLink(from, links.get(from)?.name ?? pendingNames.get(from) ?? 'Ведущий')
    await pc.setRemoteDescription(data.sdp)
    await pc.setLocalDescription(await pc.createAnswer())
    sendSignal(from, { sdp: pc.localDescription!.toJSON() })
  } else if (data.sdp?.type === 'answer') {
    await links.get(from)?.pc.setRemoteDescription(data.sdp)
  } else if (data.candidate) {
    await links.get(from)?.pc.addIceCandidate(data.candidate).catch(() => {})
  }
}

// Names of hosts announced by "join" before their offer arrives.
const pendingNames = new Map<string, string>()
let signalChain: Promise<void> = Promise.resolve()

function connect() {
  const token = getAuthToken()
  if (!active || !token) return
  const name = encodeURIComponent(getTelegramDisplayName())
  const ws = new WebSocket(`${API_URL.replace(/^http/, 'ws')}/api/live/room?token=${encodeURIComponent(token)}&name=${name}`)
  socket = ws
  ws.onopen = () => {
    pingTimer = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('ping'), PING_INTERVAL_MS)
  }
  ws.onmessage = (e) => {
    if (typeof e.data !== 'string' || e.data === 'pong') return
    let msg: { type: string; id?: string; name?: string; from?: string; data?: SignalData; peers?: { id: string; name: string }[] }
    try {
      msg = JSON.parse(e.data)
    } catch {
      return
    }
    if (msg.type === 'welcome') {
      // We are the newcomer: we call everyone already here.
      for (const p of msg.peers ?? []) callPeer(p.id, p.name).catch(() => {})
    } else if (msg.type === 'join' && msg.id) {
      pendingNames.set(msg.id, msg.name ?? 'Ведущий')
    } else if (msg.type === 'leave' && msg.id) {
      pendingNames.delete(msg.id)
      dropLink(msg.id)
    } else if (msg.type === 'signal' && msg.from && msg.data) {
      // One at a time, in arrival order: a candidate must not overtake its offer.
      const { from, data } = msg
      signalChain = signalChain.then(() => onSignal(from, data)).catch(() => {})
    }
  }
  ws.onclose = () => {
    if (pingTimer) clearInterval(pingTimer)
    pingTimer = null
    if (socket !== ws) return
    socket = null
    // The room gave us a new id on reconnect, so the others treat us as new:
    // drop the old links and let the welcome set them up again.
    ;[...links.keys()].forEach(dropLink)
    if (active) reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS)
  }
}

export function joinCall(stream: MediaStream, servers: RTCIceServer[] | undefined): void {
  if (typeof RTCPeerConnection === 'undefined') return
  active = true
  micStream = stream
  iceServers = servers ?? []
  connect()
}

export function leaveCall(): void {
  active = false
  if (reconnectTimer) clearTimeout(reconnectTimer)
  reconnectTimer = null
  const ws = socket
  socket = null
  if (pingTimer) clearInterval(pingTimer)
  pingTimer = null
  ws?.close()
  ;[...links.keys()].forEach(dropLink)
  pendingNames.clear()
  micStream = null
  state = { peers: [], needsTap: false }
  emit()
}
