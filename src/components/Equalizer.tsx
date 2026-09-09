import { useEffect, useRef } from 'react'

interface EqualizerProps {
  analyser: AnalyserNode | null
}

const FALLBACK_BAR_COUNT = 24
const BAR_GAP = 3
// iOS Safari has a known, long-standing WebKit limitation: for some
// streamed/hardware-decoded <audio> sources, MediaElementAudioSourceNode
// silently produces all-zero analyser data forever — playback through the
// speakers keeps working completely normally (this isn't the CORS-taint
// case, which we've already ruled out server-side), the Web Audio tap
// itself just never receives real samples. Confirmed live: real audio
// audibly playing, bars frozen flat. There's no reliable pure-JS fix for
// that WebKit gap, so rather than leave the equalizer looking dead on
// affected devices, it switches to a decorative animation once it's had
// a fair chance to see real energy and hasn't — anywhere the real tap
// does work, genuine audio-reactive bars keep taking priority.
const REAL_DATA_GRACE_MS = 4000
const REAL_DATA_THRESHOLD = 0.05

/**
 * Thin-line, technical-schematic style bar visualizer (matches the
 * reference flyer art — not a glowing neon meter). Purely a renderer: the
 * caller owns creating/resuming the actual Web Audio graph
 * (see useAudioAnalyser) and just hands over the node to read from.
 */
export function Equalizer({ analyser }: EqualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx || !analyser) return

    const data = new Uint8Array(analyser.frequencyBinCount)
    let rafId: number
    let startedAt: number | null = null
    let sawRealData = false

    function draw(now: number) {
      rafId = requestAnimationFrame(draw)
      if (startedAt === null) startedAt = now

      analyser!.getByteFrequencyData(data)
      const maxLevel = data.reduce((max, v) => Math.max(max, v), 0) / 255
      if (maxLevel > REAL_DATA_THRESHOLD) sawRealData = true

      const useFallback = !sawRealData && now - startedAt > REAL_DATA_GRACE_MS

      const { width, height } = canvas!
      ctx!.clearRect(0, 0, width, height)
      ctx!.fillStyle = '#ffffff'

      const barCount = useFallback ? FALLBACK_BAR_COUNT : data.length
      const barWidth = (width - BAR_GAP * (barCount - 1)) / barCount

      for (let i = 0; i < barCount; i++) {
        const level = useFallback
          ? 0.08 + ((Math.sin(now / 220 + i * 0.7) + 1) / 2) * 0.55
          : data[i] / 255
        const barHeight = Math.max(2, level * height)
        ctx!.fillRect(i * (barWidth + BAR_GAP), height - barHeight, barWidth, barHeight)
      }
    }
    rafId = requestAnimationFrame(draw)

    return () => cancelAnimationFrame(rafId)
  }, [analyser])

  return <canvas ref={canvasRef} className="equalizer" width={320} height={36} />
}
