import telegramIcon from '../assets/icons/telegram.png'
import instagramIcon from '../assets/icons/instagram.png'
import vkIcon from '../assets/icons/vk.png'
import yandexIcon from '../assets/icons/yandex.png'

interface SocialLink {
  name: string
  href: string
  icon: string
}

const LINKS: SocialLink[] = [
  { name: 'Telegram', href: 'https://t.me/bigunderparty', icon: telegramIcon },
  {
    name: 'Instagram',
    href: 'https://www.instagram.com/bigunderpromo?stkn=dGw3MWdibmprN2w%3D&utm_source=qr',
    icon: instagramIcon,
  },
  { name: 'VK', href: 'https://vk.ru/bigunderp', icon: vkIcon },
  {
    name: 'Яндекс Музыка',
    href: 'https://music.yandex.ru/artist/10614441?ref_id=36372AA8-F5EB-41A7-B9D8-3A523CC7153F&utm_medium=copy_link',
    icon: yandexIcon,
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

        <h2>УЗНАТЬ О НАС</h2>

        <ul className="info-screen__links">
          {LINKS.map((link) => (
            <li key={link.name}>
              <a href={link.href} target="_blank" rel="noreferrer" className="info-screen__link">
                <img src={link.icon} alt="" className="info-screen__link-icon" />
                <span className="info-screen__link-name">{link.name}</span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
