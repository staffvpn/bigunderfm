// Visual cards for BIGUNDER RADIO: drawn on a canvas in the browser, so the
// fonts and Cyrillic come out exactly as designed and the server does no
// image work. One visual language for every card: black and white, a
// heavy grotesk against an elegant serif italic, thin rules, magazine
// meta rows.
import '@fontsource/inter-tight/cyrillic-900.css'
import '@fontsource/inter-tight/latin-900.css'
import '@fontsource/playfair-display/cyrillic-400.css'
import '@fontsource/playfair-display/latin-400.css'
import '@fontsource/playfair-display/cyrillic-400-italic.css'
import '@fontsource/playfair-display/latin-400-italic.css'
import '@fontsource/archivo-black/latin-400.css'

export type CardType = 'now' | 'show' | 'guest' | 'select'
export type CardFormat = 'feed' | 'square' | 'story' | 'wide'

export const FORMATS: Record<CardFormat, { w: number; h: number; label: string }> = {
  feed: { w: 1080, h: 1350, label: '4:5' },
  square: { w: 1080, h: 1080, label: '1:1' },
  story: { w: 1080, h: 1920, label: '9:16' },
  wide: { w: 1920, h: 1080, label: '16:9' },
}

export interface CardData {
  // now playing
  artist: string
  title: string
  label: string
  time: string
  // show / guest
  showTitle: string
  description: string
  days: string
  start: string
  number: string
  nameA: string
  nameB: string
  // selection
  selTitle: string
  selMood: string
  curator: string
  items: { artist: string; title: string }[]
  date: string
}

export interface CardSpec {
  type: CardType
  format: CardFormat
  variant: number
  data: CardData
  photo: HTMLImageElement | null
}

const INK = '#0a0a0a'
const PAPER = '#f1efe9'
const WHITE = '#ffffff'
const GROT = '"Inter Tight", "Helvetica Neue", Arial, sans-serif'
const SERIF = '"Playfair Display", Georgia, serif'
const DISPLAY = '"Archivo Black", "Inter Tight", sans-serif'

let fontsReady: Promise<void> | null = null
export function loadCardFonts(): Promise<void> {
  if (!fontsReady) {
    const probe = 'АБВ abc 0123'
    fontsReady = Promise.all([
      document.fonts.load(`900 80px "Inter Tight"`, probe),
      document.fonts.load(`700 40px "Inter Tight"`, probe),
      document.fonts.load(`400 40px "Playfair Display"`, probe),
      document.fonts.load(`italic 400 40px "Playfair Display"`, probe),
      document.fonts.load(`400 80px "Archivo Black"`, 'ABC'),
    ]).then(() => undefined)
  }
  return fontsReady
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
}

// ---------- drawing helpers ----------

type Ctx = CanvasRenderingContext2D

function font(ctx: Ctx, weight: string, size: number, family: string, italic = false) {
  ctx.font = `${italic ? 'italic ' : ''}${weight} ${Math.round(size)}px ${family}`
}

/** Black-and-white photo drawn like CSS object-fit: cover. */
function photo(ctx: Ctx, img: HTMLImageElement | null, x: number, y: number, w: number, h: number, focusY = 0.45, dim = 0) {
  ctx.save()
  ctx.beginPath()
  ctx.rect(x, y, w, h)
  ctx.clip()
  if (!img) {
    ctx.fillStyle = '#d9d7d0'
    ctx.fillRect(x, y, w, h)
  } else {
    const s = Math.max(w / img.width, h / img.height)
    const dw = img.width * s
    const dh = img.height * s
    const off = document.createElement('canvas')
    off.width = Math.max(1, Math.round(w))
    off.height = Math.max(1, Math.round(h))
    const o = off.getContext('2d')!
    o.drawImage(img, (w - dw) / 2, (h - dh) * focusY, dw, dh)
    // grayscale with a bit of punch, done by hand: canvas filters are not
    // available in every Telegram WebView
    const px = o.getImageData(0, 0, off.width, off.height)
    const d = px.data
    for (let i = 0; i < d.length; i += 4) {
      let v = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
      v = (v - 128) * 1.15 + 128
      v = v * (1 - dim)
      d[i] = d[i + 1] = d[i + 2] = v < 0 ? 0 : v > 255 ? 255 : v
    }
    o.putImageData(px, 0, 0)
    ctx.drawImage(off, x, y)
  }
  ctx.restore()
}

/** Largest font size (<= max) at which the text fits in one line of maxW. */
function fit(ctx: Ctx, text: string, weight: string, family: string, maxW: number, max: number, min: number, italic = false): number {
  let size = max
  while (size > min) {
    font(ctx, weight, size, family, italic)
    if (ctx.measureText(text).width <= maxW) break
    size -= Math.max(1, size * 0.04)
  }
  font(ctx, weight, size, family, italic)
  return size
}

/** Splits text into lines no wider than maxW (by words, long words kept whole). */
function wrap(ctx: Ctx, text: string, maxW: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let line = ''
  for (const w of words) {
    const test = line ? `${line} ${w}` : w
    if (line && ctx.measureText(test).width > maxW) {
      lines.push(line)
      line = w
    } else line = test
  }
  if (line) lines.push(line)
  return lines
}

/**
 * Fits a block of text into a box: the biggest size at which it wraps into
 * at most maxLines lines, none wider than maxW. Returns the lines and size.
 */
function fitBlock(ctx: Ctx, text: string, weight: string, family: string, maxW: number, max: number, min: number, maxLines: number, italic = false) {
  let size = max
  let lines: string[] = [text]
  while (size >= min) {
    font(ctx, weight, size, family, italic)
    lines = wrap(ctx, text, maxW)
    const widest = Math.max(...lines.map((l) => ctx.measureText(l).width))
    if (lines.length <= maxLines && widest <= maxW) break
    size -= Math.max(1, size * 0.05)
  }
  font(ctx, weight, size, family, italic)
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines)
    lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, '') + '…'
  }
  return { lines, size }
}

/** Small tracked capitals for meta rows (letter spacing drawn by hand). */
function tracked(ctx: Ctx, text: string, x: number, y: number, size: number, color: string, align: 'left' | 'center' | 'right' = 'left', spacing = 0.14) {
  font(ctx, '700', size, GROT)
  ctx.fillStyle = color
  const chars = [...text.toUpperCase()]
  const gap = size * spacing
  const width = chars.reduce((s, c) => s + ctx.measureText(c).width + gap, 0) - gap
  let cx = align === 'left' ? x : align === 'right' ? x - width : x - width / 2
  ctx.textAlign = 'left'
  for (const c of chars) {
    ctx.fillText(c, cx, y)
    cx += ctx.measureText(c).width + gap
  }
  return width
}

function rule(ctx: Ctx, x: number, y: number, w: number, color: string, t = 2) {
  ctx.fillStyle = color
  ctx.fillRect(x, y, w, t)
}

function metaRow(ctx: Ctx, items: string[], x: number, y: number, w: number, size: number, color: string) {
  if (items[0]) tracked(ctx, items[0], x, y, size, color, 'left')
  if (items[1]) tracked(ctx, items[1], x + w / 2, y, size, color, 'center')
  if (items[2]) tracked(ctx, items[2], x + w, y, size, color, 'right')
}

function footer(ctx: Ctx, x: number, y: number, w: number, s: number, color: string) {
  ctx.textBaseline = 'alphabetic'
  font(ctx, '900', s * 1.25, GROT)
  ctx.fillStyle = color
  ctx.textAlign = 'left'
  ctx.fillText('BIGUNDER FM', x, y)
  font(ctx, '400', s * 1.15, SERIF, true)
  ctx.textAlign = 'right'
  ctx.fillText('Underground on air', x + w, y)
  ctx.textAlign = 'left'
}

const isLatin = (c: string) => /[A-Za-z0-9]/.test(c)

// ---------- templates ----------

interface Frame {
  W: number
  H: number
  m: number // side margin
  top: number // safe top (stories leave room for the app's header)
  bottom: number // safe bottom
  s: number // base unit for small text
  wide: boolean
}

function frame(format: CardFormat): Frame {
  const { w, h } = FORMATS[format]
  const short = Math.min(w, h)
  const m = Math.round(short * 0.052)
  const story = format === 'story'
  return {
    W: w,
    H: h,
    m,
    top: story ? Math.round(h * 0.1) : m,
    bottom: story ? Math.round(h * 0.11) : m,
    s: Math.round(short * 0.021),
    wide: format === 'wide',
  }
}

function drawNow(ctx: Ctx, f: Frame, d: CardData, img: HTMLImageElement | null, v: number) {
  const dark = v % 2 === 1
  const bg = dark ? INK : WHITE
  const fg = dark ? WHITE : INK
  const { W, H, m, s } = f
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, W, H)
  const artist = (d.artist || 'ARTIST').toUpperCase()
  const title = d.title || 'Track title'
  if (f.wide) {
    const pw = W * 0.5
    photo(ctx, img, 0, 0, pw, H, 0.4)
    const x = pw + m
    const cw = W - x - m
    metaRow(ctx, ['BIGUNDER RADIO', '', d.time], x, f.top + s, cw, s, fg)
    rule(ctx, x, f.top + s * 1.9, cw, fg)
    const a = fitBlock(ctx, artist, '900', GROT, cw, H * 0.17, s * 2, 2)
    ctx.fillStyle = fg
    let y = f.top + s * 3.5
    for (const l of a.lines) {
      y += a.size * 0.86
      ctx.fillText(l, x - a.size * 0.03, y)
    }
    y += a.size * 0.25
    const t = fitBlock(ctx, title, '400', SERIF, cw, H * 0.06, s * 1.2, 2, true)
    y += t.size * 0.4
    for (const l of t.lines) {
      ctx.fillText(l, x, y)
      y += t.size * 1.1
    }
    tracked(ctx, 'NOW PLAYING' + (d.label ? ' · ' + d.label : ''), x, H - f.bottom - s * 3.2, s, fg)
    rule(ctx, x, H - f.bottom - s * 2.4, cw, fg)
    footer(ctx, x, H - f.bottom, cw, s, fg)
    return
  }
  const ph = Math.round(H * (f.H > f.W * 1.5 ? 0.58 : f.H === f.W ? 0.5 : 0.56))
  photo(ctx, img, 0, 0, W, ph, 0.4)
  // shade under the top meta row so it reads on any photo
  const g = ctx.createLinearGradient(0, 0, 0, f.top + s * 4)
  g.addColorStop(0, 'rgba(0,0,0,0.45)')
  g.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, W, f.top + s * 4)
  metaRow(ctx, ['BIGUNDER RADIO', 'NOW PLAYING', d.time], m, f.top + s, W - 2 * m, s, WHITE)
  // the artist name, big, right under the photo: one or two lines
  const bottomY = H - f.bottom - s * 4.6
  const a = fitBlock(ctx, artist, '900', GROT, W - 2 * m * 0.8, H * (f.H > f.W * 1.5 ? 0.14 : 0.17), s * 2, 2)
  ctx.fillStyle = fg
  ctx.textBaseline = 'alphabetic'
  let y = ph + s * 0.6
  for (const l of a.lines) {
    y += a.size * 0.82
    ctx.fillText(l, m * 0.8, y)
  }
  const t = fitBlock(ctx, title, '400', SERIF, W - 2 * m, Math.max(s * 1.6, a.size * 0.38), s * 1.3, 2, true)
  y += t.size * 1.25
  for (const l of t.lines) {
    if (y > bottomY - s) break
    ctx.fillText(l, m, y)
    y += t.size * 1.12
  }
  rule(ctx, m, bottomY, W - 2 * m, fg)
  metaRow(ctx, [d.label || 'BOOM BAP', '', d.date], m, bottomY + s * 1.9, W - 2 * m, s, fg)
  footer(ctx, m, H - f.bottom, W - 2 * m, s, fg)
}

function drawShow(ctx: Ctx, f: Frame, d: CardData, img: HTMLImageElement | null, v: number) {
  const dark = v % 2 === 1
  const bg = dark ? INK : PAPER
  const fg = dark ? PAPER : INK
  const { W, H, m, s } = f
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, W, H)
  const title = (d.showTitle || 'B-SIDE SHOW').toUpperCase()
  metaRow(ctx, ['BIGUNDER RADIO', 'ПРОГРАММА', d.number ? `№ ${d.number}` : ''], m, f.top + s, W - 2 * m, s, fg)
  rule(ctx, m, f.top + s * 1.9, W - 2 * m, fg)
  // giant first letter, bleeding off the right edge
  const letter = [...title][0] || 'B'
  const lh = f.wide ? H * 0.95 : Math.min(H * 0.72, W * 1.0)
  font(ctx, '400', lh, isLatin(letter) ? DISPLAY : GROT)
  if (!isLatin(letter)) font(ctx, '900', lh, GROT)
  const lw = ctx.measureText(letter).width
  ctx.fillStyle = fg
  ctx.textBaseline = 'alphabetic'
  ctx.fillText(letter, W - lw * 0.82, f.top + s * 2.5 + lh * 0.74)
  const area = f.wide ? { x: m, y: f.top + s * 3.2, w: W * 0.34, h: H - f.top - f.bottom - s * 3.2 } : { x: m, y: f.top + s * 3.2, w: W * 0.48, h: H * (f.H > f.W * 1.5 ? 0.38 : f.H === f.W ? 0.36 : 0.44) }
  photo(ctx, img, area.x, area.y, area.w, area.h, 0.45)
  const tx = f.wide ? area.x + area.w + m : m
  const tw = f.wide ? W * 0.3 : W * 0.62
  let y = f.wide ? H * 0.45 : area.y + area.h + s * 1.2
  const t = fitBlock(ctx, title, '900', GROT, tw, H * (f.wide ? 0.16 : 0.105), s * 2, 3)
  ctx.fillStyle = fg
  for (const l of t.lines) {
    y += t.size * 0.86
    ctx.fillText(l, tx - t.size * 0.03, y)
  }
  if (d.description) {
    const ds = fitBlock(ctx, d.description, '400', SERIF, f.wide ? tw : W * 0.5, s * 1.65, s * 1.05, 3, true)
    y += ds.size * 1.6
    for (const l of ds.lines) {
      ctx.fillText(l, tx, y)
      y += ds.size * 1.25
    }
  }
  // the start time like a number on a sports jersey: outlined
  const time = d.start || '19:00'
  const ts = fit(ctx, time, '900', GROT, W * (f.wide ? 0.22 : 0.4), H * (f.wide ? 0.12 : 0.12), s * 2)
  ctx.textAlign = 'right'
  ctx.lineWidth = Math.max(2, ts * 0.022)
  ctx.strokeStyle = fg
  ctx.fillStyle = bg
  const tyy = H - f.bottom - s * 2.2
  ctx.fillText(time, W - m, tyy)
  ctx.strokeText(time, W - m, tyy)
  ctx.textAlign = 'left'
  tracked(ctx, d.days || 'ВТОРНИК', W - m, H - f.bottom, s, fg, 'right')
  tracked(ctx, '@BIGUNDERADIOBOT', m, H - f.bottom, s, fg, 'left')
}

function drawGuest(ctx: Ctx, f: Frame, d: CardData, img: HTMLImageElement | null, v: number) {
  const { W, H, m, s } = f
  const plain = v % 2 === 1
  ctx.fillStyle = INK
  ctx.fillRect(0, 0, W, H)
  if (!plain) photo(ctx, img, 0, 0, W, H, 0.4, 0.45)
  metaRow(ctx, ['BIGUNDER RADIO', 'GUEST SHOW', d.days], m, f.top + s, W - 2 * m, s, WHITE)
  rule(ctx, m, f.top + s * 1.9, W - 2 * m, WHITE)
  const a = (d.nameA || 'BIGUNDER').toUpperCase()
  const b = (d.nameB || '').toUpperCase()
  const maxW = W - 2 * m
  const sizeA = fit(ctx, a, '900', GROT, maxW, H * (f.wide ? 0.2 : 0.13), s * 2)
  const sizeB = b ? fit(ctx, b, '900', GROT, maxW, H * (f.wide ? 0.2 : 0.13), s * 2) : 0
  const size = b ? Math.min(sizeA, sizeB) : sizeA
  const vsSize = size * 0.5
  const blockH = b ? size * 0.86 * 2 + vsSize * 1.3 : size * 0.86
  let y = (H - blockH) / 2 + size * 0.7 - (f.wide ? 0 : H * 0.03)
  ctx.textAlign = 'center'
  ctx.fillStyle = WHITE
  font(ctx, '900', size, GROT)
  font(ctx, '900', size, GROT)
  ctx.fillText(a, W / 2, y)
  if (b) {
    y += vsSize * 1.25
    font(ctx, '400', vsSize, SERIF, true)
    ctx.fillText('vs', W / 2, y)
    y += size * 0.95
    font(ctx, '900', size, GROT)
    ctx.fillText(b, W / 2, y)
  }
  ctx.textAlign = 'left'
  if (d.showTitle) {
    fit(ctx, d.showTitle, '400', SERIF, W - 2 * m, s * 3, s * 1.4, true)
    ctx.fillStyle = WHITE
    ctx.fillText(d.showTitle, m, H - f.bottom - s * 3.4)
  }
  rule(ctx, m, H - f.bottom - s * 2.3, W - 2 * m, WHITE)
  const when = [d.days, d.start].filter(Boolean).join(' · ')
  metaRow(ctx, [when, '', '@BIGUNDERADIOBOT'], m, H - f.bottom, W - 2 * m, s, WHITE)
}

function drawSelect(ctx: Ctx, f: Frame, d: CardData, img: HTMLImageElement | null, v: number) {
  const dark = v % 2 === 1
  const bg = dark ? INK : WHITE
  const fg = dark ? WHITE : INK
  const muted = dark ? '#8f8f8f' : '#7a7a7a'
  const { W, H, m, s } = f
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, W, H)
  metaRow(ctx, ['BIGUNDER RADIO', 'ПОДБОРКА', d.date], m, f.top + s, W - 2 * m, s, fg)
  rule(ctx, m, f.top + s * 1.9, W - 2 * m, fg)
  const col = f.wide ? { x: m, w: W * 0.4 } : { x: m, w: W - 2 * m }
  let y = f.top + s * 3
  if (f.wide && img) photo(ctx, img, W * 0.46, f.top + s * 3, W * 0.54 - m, H - f.top - f.bottom - s * 3, 0.4)
  const t = fitBlock(ctx, (d.selTitle || 'ТОП НЕДЕЛИ').toUpperCase(), '900', GROT, col.w, H * (f.wide ? 0.14 : 0.11), s * 2, 2)
  ctx.fillStyle = fg
  for (const l of t.lines) {
    y += t.size * 0.86
    ctx.fillText(l, col.x - t.size * 0.03, y)
  }
  if (d.selMood) {
    const md = fitBlock(ctx, d.selMood, '400', SERIF, col.w, s * 2.2, s * 1.2, 2, true)
    y += md.size * 1.4
    for (const l of md.lines) {
      ctx.fillText(l, col.x, y)
      y += md.size * 1.15
    }
  }
  const items = d.items.slice(0, f.H === f.W ? 5 : f.wide ? 5 : 6)
  const listTop = y + s * 1.6
  const listBottom = H - f.bottom - s * 4.4
  const rowH = Math.min(s * (f.H > f.W * 1.5 ? 7 : 5.2), (listBottom - listTop) / Math.max(1, items.length))
  items.forEach((it, i) => {
    const ry = listTop + i * rowH
    rule(ctx, col.x, ry, col.w, fg, 1.5)
    const num = String(i + 1).padStart(2, '0')
    const ns = rowH * 0.62
    font(ctx, '900', ns, GROT)
    ctx.lineWidth = Math.max(1.5, ns * 0.03)
    ctx.strokeStyle = fg
    ctx.strokeText(num, col.x, ry + rowH * 0.78)
    const nx = col.x + ctx.measureText('00').width + s * 1.2
    const tw = col.x + col.w - nx
    ctx.fillStyle = fg
    fit(ctx, (it.artist || '').toUpperCase(), '900', GROT, tw, rowH * 0.36, s * 0.9)
    ctx.fillText((it.artist || '').toUpperCase(), nx, ry + rowH * 0.45)
    ctx.fillStyle = muted
    fit(ctx, it.title || '', '400', SERIF, tw, rowH * 0.32, s * 0.9, true)
    ctx.fillText(it.title || '', nx, ry + rowH * 0.82)
  })
  ctx.fillStyle = fg
  if (d.curator) tracked(ctx, `КУРАТОР: ${d.curator}`, col.x, H - f.bottom - s * 2.6, s * 0.9, muted)
  footer(ctx, col.x, H - f.bottom, col.w, s, fg)
}

/** Draws the card into the canvas, resizing it to the format. */
export async function renderCard(canvas: HTMLCanvasElement, spec: CardSpec): Promise<void> {
  await loadCardFonts()
  const f = frame(spec.format)
  canvas.width = f.W
  canvas.height = f.H
  const ctx = canvas.getContext('2d')!
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'
  if (spec.type === 'now') drawNow(ctx, f, spec.data, spec.photo, spec.variant)
  if (spec.type === 'show') drawShow(ctx, f, spec.data, spec.photo, spec.variant)
  if (spec.type === 'guest') drawGuest(ctx, f, spec.data, spec.photo, spec.variant)
  if (spec.type === 'select') drawSelect(ctx, f, spec.data, spec.photo, spec.variant)
}

export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('png'))), 'image/png'))
}
