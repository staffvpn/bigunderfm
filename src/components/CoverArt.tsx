interface CoverArtProps {
  coverUrl: string | null
  alt: string
}

export function CoverArt({ coverUrl, alt }: CoverArtProps) {
  return (
    <div className="cover-art">
      {coverUrl ? (
        <img src={coverUrl} alt={alt} className="cover-art__image" />
      ) : (
        <div className="cover-art__placeholder">BIGUNDER FM</div>
      )}
    </div>
  )
}
