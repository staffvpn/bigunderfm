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
