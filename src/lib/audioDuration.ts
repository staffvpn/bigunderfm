/**
 * Reads a local audio file's real duration by actually loading it into a
 * native <audio> element, rather than parsing container/ID3 headers by hand.
 *
 * This is deliberately separate from metadata.ts's tag extraction (which
 * uses music-metadata-browser): that library's header parsing silently
 * fails for a meaningful slice of real-world files (observed: 100% failure
 * rate across a real upload batch of mixed .mp3/.wav files, caught by its
 * own try/catch and surfaced only as "could not determine duration"). Since
 * every browser can already decode whatever it can play, asking it directly
 * is both simpler and strictly more reliable — and duration is the one
 * field that's load-bearing (radioClock's virtual timeline math depends on
 * every track having a real, positive duration).
 */
export function getNativeDuration(file: File): Promise<number> {
  return new Promise((resolve) => {
    const audio = document.createElement('audio')
    const url = URL.createObjectURL(file)

    function cleanup() {
      URL.revokeObjectURL(url)
      audio.removeAttribute('src')
      audio.load()
    }

    audio.preload = 'metadata'
    audio.onloadedmetadata = () => {
      const duration = audio.duration
      cleanup()
      // Some encodings report Infinity until the browser has streamed the
      // whole file (a seek-to-end trick fixes this for network streams, but
      // local File blobs are always fully available, so this is mostly a
      // defensive fallback rather than an expected case here).
      resolve(Number.isFinite(duration) && duration > 0 ? duration : 0)
    }
    audio.onerror = () => {
      cleanup()
      resolve(0)
    }
    audio.src = url
  })
}
