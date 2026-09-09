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

// A smooth continuous sine wave reads as a screensaver, not "reacting to
// music" — real VU/spectrum meters move in sharp, uneven hits with a fast
// rise and a slower fall (ballistics), not a gentle rolling ripple. The
// fallback fakes exactly that instead: on a rough beat clock, bars jump to
// new random heights (not all of them, and not all by the same amount —
// real drum/bass hits don't move every frequency band at once) then decay
// back down before the next hit.
const BEAT_INTERVAL_MS = 460
const BEAT_JITTER_MS = 90 // avoids a too-metronomic, robotic feel
const BEAT_ATTACK = 0.55 // per-frame pull toward a new (higher) target — fast
const BEAT_DECAY = 0.08 // per-frame pull toward a new (lower) target — slower

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

    const fallbackLevels = new Array(FALLBACK_BAR_COUNT).fill(0)
    const fallbackTargets = new Array(FALLBACK_BAR_COUNT).fill(0)
    let nextBeatAt = 0

    function updateFallbackLevels(now: number) {
      if (now >= nextBeatAt) {
        nextBeatAt = now + BEAT_INTERVAL_MS + (Math.random() - 0.5) * 2 * BEAT_JITTER_MS
        for (let i = 0; i < FALLBACK_BAR_COUNT; i++) {
          // Most bars get a real hit; a few sit out this beat entirely —
          // uniform movement across every bar on every tick is exactly
          // what reads as fake.
          fallbackTargets[i] = Math.random() < 0.75 ? 0.22 + Math.random() * 0.78 : 0.04 + Math.random() * 0.15
        }
      }
      for (let i = 0; i < FALLBACK_BAR_COUNT; i++) {
        const target = fallbackTargets[i]
        const rate = target > fallbackLevels[i] ? BEAT_ATTACK : BEAT_DECAY
        fallbackLevels[i] += (target - fallbackLevels[i]) * rate
      }
    }

    function draw(now: number) {
      rafId = requestAnimationFrame(draw)
      if (startedAt === null) startedAt = now

      analyser!.getByteFrequencyData(data)
      const maxLevel = data.reduce((max, v) => Math.max(max, v), 0) / 255
      if (maxLevel > REAL_DATA_THRESHOLD) sawRealData = true

      const useFallback = !sawRealData && now - startedAt > REAL_DATA_GRACE_MS
      if (useFallback) updateFallbackLevels(now)

      const { width, height } = canvas!
      ctx!.clearRect(0, 0, width, height)
      ctx!.fillStyle = '#ffffff'

      const barCount = useFallback ? FALLBACK_BAR_COUNT : data.length
      const barWidth = (width - BAR_GAP * (barCount - 1)) / barCount

      for (let i = 0; i < barCount; i++) {
        const level = useFallback ? fallbackLevels[i] : data[i] / 255
        const barHeight = Math.max(2, level * height)
        ctx!.fillRect(i * (barWidth + BAR_GAP), height - barHeight, barWidth, barHeight)
      }
    }
    rafId = requestAnimationFrame(draw)

    return () => cancelAnimationFrame(rafId)
  }, [analyser])

  return <canvas ref={canvasRef} className="equalizer" width={320} height={36} />
}
