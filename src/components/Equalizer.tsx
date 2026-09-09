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
// case, which we've already ruled out server-side, nor an element/graph
// setup-ordering bug, which we've also already tried and ruled out), the
// Web Audio tap itself just never receives real samples on that platform.
// Confirmed live, repeatedly: real audio audibly playing, bars frozen or
// moving in a way that plainly isn't tracking the actual track. There's
// no reliable pure-JS fix for that WebKit gap, so rather than leave the
// equalizer looking dead (or fake-random) on affected devices, it
// switches to a deliberately structured decorative pattern once it's had
// a fair chance to see real energy and hasn't — anywhere the real tap
// does work, genuine audio-reactive bars keep taking priority.
const REAL_DATA_GRACE_MS = 4000
const REAL_DATA_THRESHOLD = 0.05

interface FallbackBand {
  start: number
  end: number
  intervalMs: number
  phaseMs: number
  hitChance: number
  hitMin: number
  hitMax: number
  restMin: number
  restMax: number
  attack: number
  decay: number
}

const BPM = 92
const QUARTER_MS = 60000 / BPM

// The catalogue in rotation is boom-bap/lo-fi hip-hop (TEESONER, wun two,
// jazz-rap remixes) — a laid-back ~90 BPM feel, not high-energy EDM — and
// a single blob of bars all flashing on one shared clock reads as random
// noise, not a drum pattern. Three independently-ticking bands instead:
// a kick on every beat (low bars), a snare backbeat on 2-and-4 (mid bars,
// half the tempo, offset by one beat), and a busier, quieter hi-hat on
// eighth notes (high bars) — the actual skeleton of a real hip-hop groove.
const FALLBACK_BANDS: FallbackBand[] = [
  {
    start: 0,
    end: 8,
    intervalMs: QUARTER_MS,
    phaseMs: 0,
    hitChance: 0.88,
    hitMin: 0.5,
    hitMax: 1,
    restMin: 0.04,
    restMax: 0.1,
    attack: 0.65,
    decay: 0.05,
  },
  {
    start: 8,
    end: 16,
    intervalMs: QUARTER_MS * 2,
    phaseMs: QUARTER_MS,
    hitChance: 0.95,
    hitMin: 0.35,
    hitMax: 0.7,
    restMin: 0.03,
    restMax: 0.08,
    attack: 0.6,
    decay: 0.07,
  },
  {
    start: 16,
    end: 24,
    intervalMs: QUARTER_MS / 2,
    phaseMs: 0,
    hitChance: 0.55,
    hitMin: 0.1,
    hitMax: 0.4,
    restMin: 0.02,
    restMax: 0.06,
    attack: 0.7,
    decay: 0.14,
  },
]
// +/- fraction of each band's own interval — avoids a metronomic, robotic
// feel without breaking the underlying kick/snare/hat structure.
const TICK_JITTER = 0.12

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
    const nextTickAt = FALLBACK_BANDS.map((band) => band.phaseMs)
    let fallbackStartedAt: number | null = null

    function updateFallbackLevels(now: number) {
      if (fallbackStartedAt === null) fallbackStartedAt = now
      const elapsed = now - fallbackStartedAt

      FALLBACK_BANDS.forEach((band, bandIndex) => {
        if (elapsed < nextTickAt[bandIndex]) return
        const jitter = band.intervalMs * TICK_JITTER * (Math.random() * 2 - 1)
        nextTickAt[bandIndex] = elapsed + band.intervalMs + jitter
        for (let i = band.start; i < band.end; i++) {
          fallbackTargets[i] =
            Math.random() < band.hitChance
              ? band.hitMin + Math.random() * (band.hitMax - band.hitMin)
              : band.restMin + Math.random() * (band.restMax - band.restMin)
        }
      })

      FALLBACK_BANDS.forEach((band) => {
        for (let i = band.start; i < band.end; i++) {
          const target = fallbackTargets[i]
          const rate = target > fallbackLevels[i] ? band.attack : band.decay
          fallbackLevels[i] += (target - fallbackLevels[i]) * rate
        }
      })
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
