import { parseBlob } from 'music-metadata-browser'

export interface ExtractedMetadata {
  title: string
  artist: string
  durationSeconds: number
  coverBlob: Blob | null
}

export async function extractTrackMetadata(file: File): Promise<ExtractedMetadata> {
  const fallbackTitle = stripExtension(file.name)

  try {
    const metadata = await parseBlob(file)
    const picture = metadata.common.picture?.[0]

    return {
      title: metadata.common.title?.trim() || fallbackTitle,
      artist: metadata.common.artist?.trim() || 'Unknown Artist',
      durationSeconds: metadata.format.duration ?? 0,
      coverBlob: picture ? new Blob([picture.data], { type: picture.format }) : null,
    }
  } catch {
    return {
      title: fallbackTitle,
      artist: 'Unknown Artist',
      durationSeconds: 0,
      coverBlob: null,
    }
  }
}

function stripExtension(filename: string): string {
  const lastDot = filename.lastIndexOf('.')
  return lastDot > 0 ? filename.slice(0, lastDot) : filename
}
