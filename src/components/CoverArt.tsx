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
        <img src="/logo.png" alt="BIGUNDER FM" className="cover-art__image cover-art__placeholder" />
      )}
    </div>
  )
}
