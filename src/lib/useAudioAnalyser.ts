import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

// createMediaElementSource() throws if called twice on the same <audio>
// element. A module-level WeakSet (rather than a ref/state flag) guards
// against that regardless of React re-render timing — including
// StrictMode's dev-only double-invoked effects, which don't reliably
// reset component-local refs the same way across the double pass.
const sourcedElements = new WeakSet<HTMLAudioElement>()

/**
 * Taps an existing <audio> element's output into a Web Audio AnalyserNode
 * for the equalizer visualizer, without altering playback — the graph
 * passes straight through to the destination (speakers), it doesn't
 * replace `audio.play()`/`.pause()`/`.currentTime` control.
 *
 * The analyser graph is created and resumed lazily via `resume()`, which
 * must be called synchronously from inside the same click handler that
 * calls `audio.play()` — Safari/iOS keeps a freshly created AudioContext
 * suspended until it sees a real user-gesture call stack, not merely a
 * React effect reacting to state that changed because of one.
 */
export function useAudioAnalyser(audioRef: RefObject<HTMLAudioElement>) {
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null)
  const contextRef = useRef<AudioContext | null>(null)

  const resume = useCallback(() => {
    const audio = audioRef.current
    if (audio && !sourcedElements.has(audio)) {
      const AudioContextCtor: typeof AudioContext | undefined =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (AudioContextCtor) {
        const audioCtx = new AudioContextCtor()
        const source = audioCtx.createMediaElementSource(audio)
        const node = audioCtx.createAnalyser()
        node.fftSize = 64
        source.connect(node)
        node.connect(audioCtx.destination)

        sourcedElements.add(audio)
        contextRef.current = audioCtx
        setAnalyser(node)
      }
      // Unsupported browser (no Web Audio API): the visualizer stays
      // blank, playback is entirely unaffected either way.
    }
    contextRef.current?.resume().catch(() => {})
  }, [audioRef])

  useEffect(() => {
    return () => {
      contextRef.current?.close().catch(() => {})
    }
  }, [])

  return { analyser, resume }
}
