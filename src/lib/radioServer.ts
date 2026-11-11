// Single source of truth for the VPS broadcast server's public HTTPS
// endpoint — RadioScreen (playback) and the admin dashboard (live stats)
// both need it; one definition avoids the two drifting if the server
// ever moves to a real domain.
export const STREAM_HOST = 'https://195-208-124-129.sslip.io'
export const STREAM_URL = `${STREAM_HOST}/radio`

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
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const resp = await fetch(`${STREAM_HOST}/status-json.xsl`, { signal: ctrl.signal, cache: 'no-store' })
    if (!resp.ok) return false
    const data = await resp.json()
    return Boolean(data?.icestats?.source)
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
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
    const resp = await fetch(`${STREAM_HOST}/status-json.xsl`)
    if (!resp.ok) return null
    const data = await resp.json()
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
