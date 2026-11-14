const LINKS = [
  { name: 'Прислать демо', href: 'https://t.me/bigunderadiobot?start=demo' },
  { name: 'Telegram', href: 'https://t.me/bigunderparty' },
  { name: 'Instagram', href: 'https://www.instagram.com/bigunderpromo?stkn=dGw3MWdibmprN2w%3D&utm_source=qr' },
  { name: 'VK', href: 'https://vk.ru/bigunderp' },
  { name: 'Яндекс Музыка', href: 'https://music.yandex.ru/artist/10614441?ref_id=36372AA8-F5EB-41A7-B9D8-3A523CC7153F&utm_medium=copy_link' },
]

/** Quiet links at the bottom of the listener screens. */
export function Socials() {
  return (
    <footer className="bfm-socials">
      {LINKS.map((l) => (
        <a key={l.name} href={l.href} target="_blank" rel="noreferrer">
          {l.name}
        </a>
      ))}
    </footer>
  )
}
