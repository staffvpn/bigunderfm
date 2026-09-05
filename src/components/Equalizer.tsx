import { useEffect, useRef } from 'react'

interface EqualizerProps {
  analyser: AnalyserNode | null
}

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

    function draw() {
      rafId = requestAnimationFrame(draw)
      analyser!.getByteFrequencyData(data)

      const { width, height } = canvas!
      ctx!.clearRect(0, 0, width, height)

      const barCount = data.length
      const gap = 3
      const barWidth = (width - gap * (barCount - 1)) / barCount
      ctx!.fillStyle = '#ffffff'

      for (let i = 0; i < barCount; i++) {
        const level = data[i] / 255
        const barHeight = Math.max(2, level * height)
        ctx!.fillRect(i * (barWidth + gap), height - barHeight, barWidth, barHeight)
      }
    }
    draw()

    return () => cancelAnimationFrame(rafId)
  }, [analyser])

  return <canvas ref={canvasRef} className="equalizer" width={320} height={36} />
}
