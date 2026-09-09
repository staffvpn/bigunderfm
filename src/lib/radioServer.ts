// Single source of truth for the VPS broadcast server's public HTTPS
// endpoint — RadioScreen (playback) and the admin dashboard (live stats)
// both need it; one definition avoids the two drifting if the server
// ever moves to a real domain.
export const STREAM_HOST = 'https://159-194-234-135.sslip.io'
export const STREAM_URL = `${STREAM_HOST}/radio`

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
