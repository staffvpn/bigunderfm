import { useEffect, useRef, useState } from 'react'
import { fetchLike, sendLike, type LikeState } from '../lib/likes'
import { HeartIcon } from './Icons'

/** The like of the track on air: one per person, with the count beside it. */
export function LikeButton({ trackId }: { trackId: string | undefined }) {
  const [like, setLike] = useState<LikeState | null>(null)
  const trackRef = useRef(trackId)

  useEffect(() => {
    trackRef.current = trackId
    setLike(null)
    if (!trackId) return
    fetchLike(trackId)
      .then((state) => {
        if (trackRef.current === trackId) setLike(state)
      })
      .catch(() => {})
  }, [trackId])

  function handleTap() {
    if (!trackId || like?.liked) return
    setLike({ count: (like?.count ?? 0) + 1, liked: true })
    navigator.vibrate?.(8)
    sendLike(trackId)
      .then((state) => {
        if (trackRef.current === trackId) setLike(state)
      })
      .catch(() => {})
  }

  return (
    <button type="button" className="bfm__like" onClick={handleTap} disabled={!trackId} aria-label={like?.liked ? 'Лайк уже стоит' : 'Поставить лайк треку'}>
      <HeartIcon filled={like?.liked} />
      <span>{like?.count ?? 0}</span>
    </button>
  )
}
