
interface SocialLink {
  name: string
  href: string
}

const LINKS: SocialLink[] = [
  { name: 'Telegram', href: 'https://t.me/bigunderparty' },
  {
    name: 'Instagram',
    href: 'https://www.instagram.com/bigunderpromo?stkn=dGw3MWdibmprN2w%3D&utm_source=qr',
  },
  { name: 'VK', href: 'https://vk.ru/bigunderp' },
  {
    name: 'Яндекс Музыка',
    href: 'https://music.yandex.ru/artist/10614441?ref_id=36372AA8-F5EB-41A7-B9D8-3A523CC7153F&utm_medium=copy_link',
  },
]

// Shell reuses RadioScreen's own container classes (radio-screen /
// radio-screen__header / radio-screen__station) rather than a parallel
// set of near-identical rules — "same style as Эфир" per request, and
// this way the two can never visually drift apart later.
export function InfoScreen() {
  return (
    <div className="radio-screen">
      <div className="radio-screen__content">
        <div className="radio-screen__header">
          <span className="radio-screen__station">BIGUNDER FM</span>
        </div>

        <div>
          <h2 className="page-title">о нас</h2>
          <span className="page-sub">Мы в сети</span>
        </div>

        {/* A list like the ones on bigunder.ru: thin rules, big names, a small arrow. */}
        <ul className="info-screen__links">
          {LINKS.map((link) => (
            <li key={link.name}>
              <a href={link.href} target="_blank" rel="noreferrer" className="info-screen__link">
                <span className="info-screen__link-name">{link.name}</span>
                <span className="info-screen__link-arrow" aria-hidden="true">
                  ↗
                </span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
