/**
 * Builds a Supabase Storage object key for an uploaded track.
 *
 * Deliberately does NOT embed the original filename: Storage rejects keys
 * containing spaces or non-ASCII characters ("Invalid key"), and real
 * uploads routinely have both (e.g. Cyrillic titles, spaces). The original
 * name is never needed from the storage key anyway — it's preserved
 * separately as the track's title/tag metadata.
 */
export function buildTrackFilePath(originalName: string, id: string = crypto.randomUUID()): string {
  return `${id}${safeExtension(originalName)}`
}

function safeExtension(filename: string): string {
  const match = filename.match(/\.([a-zA-Z0-9]+)$/)
  return match ? `.${match[1].toLowerCase()}` : ''
}

/**
 * Maps a filename's extension to the exact Content-Type string the `tracks`
 * Storage bucket's `allowed_mime_types` accepts (see 0003_storage.sql).
 *
 * Deliberately does not trust the browser-supplied `File.type`: some
 * browsers/OSes report `.wav` as `audio/x-wav` or `audio/wave` instead of
 * the bucket's exact `audio/wav`, which Storage would reject outright.
 * Falls back to the browser's own type only for an extension we don't
 * recognize, so a matching bucket type is never overridden with a guess.
 */
export function audioContentType(filename: string, browserType: string): string {
  switch (safeExtension(filename)) {
    case '.mp3':
      return 'audio/mpeg'
    case '.wav':
      return 'audio/wav'
    case '.m4a':
    case '.mp4':
      return 'audio/mp4'
    default:
      return browserType
  }
}
