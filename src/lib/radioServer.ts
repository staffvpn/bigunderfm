// Single source of truth for the VPS broadcast server's public HTTPS
// endpoint — RadioScreen (playback) and the admin dashboard (live stats)
// both need it; one definition avoids the two drifting if the server
// ever moves to a real domain.
const DIRECT_HOST = 'https://195-208-124-129.sslip.io'
// Cloudflare relay (functions/hls, functions/status-json.xsl.ts). Listeners whose
// network or VPN cannot open the server itself get the same air from here as
// short HLS files, about 20 seconds behind the direct stream.
const RELAY_HOST = 'https://bigunderfm.pages.dev'
/** How far the relayed air runs behind the server's own "now playing". */
export const RELAY_DELAY_MS = 20_000

const ROUTE_KEY = 'bfm_via_relay'
const ROUTE_TTL_MS = 30 * 60 * 1000
function relayRemembered(): boolean {
  try {
    return Date.now() - Number(localStorage.getItem(ROUTE_KEY)) < ROUTE_TTL_MS
  } catch {
    return false
  }
}
let viaRelay = relayRemembered()
function setRoute(relay: boolean) {
  viaRelay = relay
  try {
    if (relay) localStorage.setItem(ROUTE_KEY, String(Date.now()))
    else localStorage.removeItem(ROUTE_KEY)
  } catch {
    // storage unavailable - not important
  }
}

export const isRelayRoute = () => viaRelay
export const statusUrl = () => `${viaRelay ? RELAY_HOST : DIRECT_HOST}/status-json.xsl`

async function fetchStatusFrom(host: string, timeoutMs: number): Promise<any | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const resp = await fetch(`${host}/status-json.xsl`, { signal: ctrl.signal, cache: 'no-store' })
    if (!resp.ok) return null
    const data = await resp.json()
    return data?.icestats?.source ? data : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** Finds a route to the live air (direct, else the relay) and switches to it. Null: the server is off air. */
async function pickRoute(timeoutMs: number): Promise<any | null> {
  const direct = fetchStatusFrom(DIRECT_HOST, timeoutMs)
  const relay = fetchStatusFrom(RELAY_HOST, timeoutMs)
  const use = (isRelay: boolean, data: any) => {
    setRoute(isRelay)
    return data
  }
  if (viaRelay) {
    // Direct gets a short head start to win back a listener who turned the VPN off.
    const quick = await Promise.race([direct, new Promise<null>((r) => setTimeout(() => r(null), 1200))])
    if (quick) return use(false, quick)
    const r = await relay
    if (r) return use(true, r)
    const d = await direct
    return d ? use(false, d) : null
  }
  // Direct is preferred, but once the relay has answered it only gets 1.5 s more.
  const wait = new Promise<null>((r) => setTimeout(() => r(null), 1500))
  const d = await Promise.race([direct, relay.then((r) => (r ? wait : direct))])
  if (d) return use(false, d)
  const r = await relay
  if (r) return use(true, r)
  const late = await direct
  return late ? use(false, late) : null
}

// ---------- playing the live air on an <audio> element ----------

let hls: { destroy(): void } | null = null
let liveToken = 0

/** Must be called before the element is pointed at anything else (the fallback's files). */
export function detachLive() {
  liveToken++
  if (hls) {
    hls.destroy()
    hls = null
  }
}

/** Points the element at the live air over the current route and starts it. */
export function playLive(audio: HTMLAudioElement) {
  detachLive()
  const token = liveToken
  if (!viaRelay) {
    audio.src = `${DIRECT_HOST}/radio`
    audio.load()
    audio.play().catch(() => {})
    return
  }
  const url = `${RELAY_HOST}/hls/live.m3u8`
  if (audio.canPlayType('application/vnd.apple.mpegurl')) {
    // iOS plays HLS itself.
    audio.src = url
    audio.load()
    audio.play().catch(() => {})
    return
  }
  import('hls.js')
    .then(({ default: Hls }) => {
      if (token !== liveToken) return
      if (!Hls.isSupported()) throw new Error('hls unsupported')
      const player = new Hls({ liveSyncDurationCount: 2, maxBufferLength: 30 })
      hls = player
      player.on(Hls.Events.MANIFEST_PARSED, () => {
        audio.play().catch(() => {})
      })
      player.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal || token !== liveToken) return
        detachLive()
        audio.dispatchEvent(new Event('error'))
      })
      player.loadSource(url)
      player.attachMedia(audio)
    })
    .catch(() => {
      if (token === liveToken) audio.dispatchEvent(new Event('error'))
    })
}

// Public R2 bucket the library lives in (same base the Worker hands the VPS).
// Used directly by the fallback player when the VPS is unreachable.
export const MEDIA_BASE = 'https://pub-4940e64168824086a7fd4cf46cf01d65.r2.dev'

// Served through a Pages Function on the app's own domain (functions/media),
// because r2.dev itself isn't reliably reachable from Russia.
const MEDIA_PROXY_BASE = 'https://bigunderfm.pages.dev/media'

export function mediaUrl(filePath: string): string {
  return `${MEDIA_PROXY_BASE}/${filePath.split('/').map(encodeURIComponent).join('/')}`
}

/**
 * True if the VPS answers its status page within `timeoutMs`. Used to decide
 * between the live Icecast stream and the R2 fallback player — the VPS sits
 * with a single hosting provider, and when that provider goes down the whole
 * radio used to go silent with it.
 */
export async function isStreamServerUp(timeoutMs = 6000): Promise<boolean> {
  return (await pickRoute(timeoutMs)) !== null
}

// Icecast's status-json.xsl escapes non-ASCII in text fields as numeric
// HTML entities (e.g. "Б" -> "&#1041;") — that's XML-safe encoding, not
// actual HTML, so it arrives as literal "&#1041;" text rather than being
// decoded automatically. Routing it through the browser's own HTML parser
// (never inserted into the live DOM) decodes it correctly for any entity,
// not just the numeric ones Icecast happens to use today.
export function decodeHtmlEntities(text: string): string {
  const el = document.createElement('textarea')
  el.innerHTML = text
  return el.value
}

export interface IcecastStatus {
  listeners: number
  peakListeners: number
  title: string | null
  bitrateKbps: number | null
  streamStartedAt: Date | null
}

/**
 * Reads the broadcast server's own live status — the only source of truth
 * for "is the stream actually up and how many people are really receiving
 * audio right now" (as opposed to how many have the app open, which is a
 * separate, presence-based number — see useListenerCount). Returns null
 * on any failure (server down, network error, unexpected shape) rather
 * than throwing, since every caller treats this as best-effort.
 */
export async function fetchIcecastStatus(): Promise<IcecastStatus | null> {
  try {
    const data = (await fetchStatusFrom(DIRECT_HOST, 6000)) ?? (await fetchStatusFrom(RELAY_HOST, 6000))
    const source = data?.icestats?.source
    if (!source) return null

    const audioInfo: string | undefined = source.audio_info
    const bitrateMatch = audioInfo?.match(/bitrate=(\d+)/)

    return {
      listeners: Number(source.listeners ?? 0),
      peakListeners: Number(source.listener_peak ?? source.listeners ?? 0),
      title: source.title ? decodeHtmlEntities(String(source.title)) : null,
      bitrateKbps: bitrateMatch ? Number(bitrateMatch[1]) : null,
      streamStartedAt: source.stream_start_iso8601 ? new Date(source.stream_start_iso8601) : null,
    }
  } catch {
    return null
  }
}
