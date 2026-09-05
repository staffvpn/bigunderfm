import { parseBlob } from 'music-metadata-browser'
import { getNativeDuration } from './audioDuration'

export interface ExtractedMetadata {
  title: string
  artist: string
  durationSeconds: number
  coverBlob: Blob | null
}

export async function extractTrackMetadata(file: File): Promise<ExtractedMetadata> {
  const fallbackTitle = stripExtension(file.name)

  const [tags, nativeDuration] = await Promise.all([extractTags(file), getNativeDuration(file)])

  return {
    title: tags?.title || fallbackTitle,
    artist: tags?.artist || 'Unknown Artist',
    // Native playback duration is authoritative — see audioDuration.ts for
    // why the tag parser's own duration field is only a fallback, not the
    // primary source, despite music-metadata-browser existing specifically
    // to read it.
    durationSeconds: nativeDuration || tags?.durationSeconds || 0,
    coverBlob: tags?.coverBlob ?? null,
  }
}

interface ExtractedTags {
  title?: string
  artist?: string
  durationSeconds?: number
  coverBlob: Blob | null
}

async function extractTags(file: File): Promise<ExtractedTags | null> {
  try {
    const metadata = await parseBlob(file)
    const picture = metadata.common.picture?.[0]

    return {
      title: metadata.common.title?.trim(),
      artist: metadata.common.artist?.trim(),
      durationSeconds: metadata.format.duration,
      coverBlob: picture ? new Blob([picture.data], { type: picture.format }) : null,
    }
  } catch {
    return null
  }
}

function stripExtension(filename: string): string {
  const lastDot = filename.lastIndexOf('.')
  return lastDot > 0 ? filename.slice(0, lastDot) : filename
}
