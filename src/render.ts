import qrcode from 'qrcode-generator'
import type { Image, SKRSContext2D } from '@napi-rs/canvas'
import type { VideoInfo } from './api.js'
import { isImageUrl } from './api.js'

const FONT = '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "Noto Sans SC", "WenQuanYi Micro Hei", sans-serif'
const WIDTH = 560
const COVER_HEIGHT = 315

// The same 24 × 24 icons used by the Koishi preview.
const ICON_PLAY = 'M12 4.99805C9.48178 4.99805 7.283 5.12616 5.73089 5.25202C4.65221 5.33949 3.81611 6.16352 3.72 7.23254C3.60607 8.4998 3.5 10.171 3.5 11.998C3.5 13.8251 3.60607 15.4963 3.72 16.76355C3.81611 17.83255 4.65221 18.6566 5.73089 18.7441C7.283 18.8699 9.48178 18.998 12 18.998C14.5185 18.998 16.7174 18.8699 18.2696 18.74405C19.3481 18.65655 20.184 17.8328 20.2801 16.76405C20.394 15.4973 20.5 13.82645 20.5 11.998C20.5 10.16965 20.394 8.49877 20.2801 7.23205C20.184 6.1633 19.3481 5.33952 18.2696 5.25205C16.7174 5.12618 14.5185 4.99805 12 4.99805zM5.60965 3.75693C7.19232 3.62859 9.43258 3.49805 12 3.49805C14.5677 3.49805 16.8081 3.62861 18.3908 3.75696C20.1881 3.90272 21.6118 5.29278 21.7741 7.09773C21.8909 8.3969 22 10.11405 22 11.998C22 13.88205 21.8909 15.5992 21.7741 16.8984C21.6118 18.7033 20.1881 20.09335 18.3908 20.23915C16.8077 20.3675 14.5677 20.498 12 20.498C9.43258 20.498 7.19232 20.3675 5.60965 20.2392C3.81206 20.0934 2.38831 18.70295 2.22603 16.8979C2.10918 15.5982 2 13.8808 2 11.998C2 10.1153 2.10918 8.39787 2.22603 7.09823C2.38831 5.29312 3.81206 3.90269 5.60965 3.75693z M14.7138 10.96875C15.50765 11.4271 15.50765 12.573 14.71375 13.0313L11.5362 14.8659C10.74235 15.3242 9.75 14.7513 9.75001 13.8346L9.75001 10.1655C9.75001 9.24881 10.74235 8.67587 11.5362 9.13422L14.7138 10.96875z'
const ICON_DANMU = 'M11.9998 4.5C9.48158 4.5 7.28277 4.62811 5.73063 4.75397C4.65193 4.84144 3.81582 5.66547 3.71971 6.7345C3.60578 8.00177 3.4997 9.67295 3.4997 11.5C3.4997 13.3271 3.60578 14.9982 3.71971 16.2655C3.81582 17.3345 4.65193 18.1586 5.73063 18.246C6.83863 18.3358 8.29085 18.4232 9.99969 18.4229V21.75C9.99969 22.0371 10.1633 22.2991 10.4211 22.4252C10.6789 22.5514 10.9859 22.5197 11.2126 22.3436L15.9235 18.4229C17.1957 18.417 18.4269 18.3323 19.4689 18.246C20.5475 18.1586 21.3835 17.3348 21.4797 16.2661C21.5936 14.9993 21.6997 13.3285 21.6997 11.5C21.6997 9.67145 21.5936 8.00061 21.4797 6.73385C21.3835 5.6651 20.5475 4.84132 19.4689 4.75385C17.9167 4.62798 15.6779 4.5 11.9998 4.5z'

export const formatCount = (value: number): string => value >= 100000000
  ? (value / 100000000).toFixed(1) + '亿'
  : value >= 10000 ? (value / 10000).toFixed(1) + '万' : String(value)

export const pageUrl = (info: VideoInfo): string => 'https://www.bilibili.com/video/' + encodeURIComponent(info.bvid || 'av' + info.aid)
export const playerUrl = (info: VideoInfo): string => 'https://player.bilibili.com/player.html?' + new URLSearchParams({
  ...(info.bvid ? { bvid: info.bvid } : { aid: String(info.aid) }), p: '1', autoplay: 'true',
}).toString()

function limit(text: string, length: number): string { return text.length > length ? text.slice(0, length) + '…' : text }

function stats(info: VideoInfo): string {
  return '播放 ' + formatCount(info.view) + ' · 弹幕 ' + formatCount(info.danmu) + ' · 点赞 ' + formatCount(info.like) + ' · 时长 ' + info.duration
}

export function formatText(info: VideoInfo, summary: string): string {
  return [info.title, 'UP：' + info.owner, stats(info),
    info.desc && info.desc !== info.title ? '简介：' + limit(info.desc, 800) : '', limit(summary, 2000),
    '立即播放：' + playerUrl(info), '原网页：' + pageUrl(info)].filter(Boolean).join('\n')
}

const escapeMarkdown = (text: string): string => text.replace(/[\\\x60*_{}\[\]<>()#+.!|~-]/g, '\\$&')

export function formatMarkdown(info: VideoInfo, summary: string, renderedCover = false): string {
  const cover = !renderedCover && isImageUrl(info.coverUrl) ? info.coverUrl.replace(/[()<>\s]/g, char => encodeURIComponent(char)) : ''
  return [cover ? '![封面 #560px #315px](' + cover + ')' : '', '**' + escapeMarkdown(info.title) + '**',
    renderedCover ? '' : 'UP：' + escapeMarkdown(info.owner),
    escapeMarkdown(renderedCover
      ? '点赞 ' + formatCount(info.like) + ' · 投币 ' + formatCount(info.coin) + ' · 收藏 ' + formatCount(info.favorite)
      : stats(info)),
    info.desc && info.desc !== info.title ? '简介：' + escapeMarkdown(limit(info.desc, 800)) : '',
    escapeMarkdown(limit(summary, 2000)), '[立即播放](' + playerUrl(info) + ')  [原网页](' + pageUrl(info) + ')']
    .filter(Boolean).join('\n\n')
}

function wrap(context: SKRSContext2D, text: string, width: number, maxLines: number): string[] {
  const lines: string[] = []
  let line = ''
  let truncated = false
  for (const char of text.replace(/\r/g, '')) {
    if (char === '\n' || (line && context.measureText(line + char).width > width)) {
      lines.push(line)
      line = char === '\n' ? '' : char
      if (lines.length >= maxLines) { truncated = true; break }
    } else line += char
  }
  if (!truncated && line) lines.push(line)
  if (truncated) {
    let last = lines[lines.length - 1]
    while (last && context.measureText(last + '…').width > width) last = last.slice(0, -1)
    lines[lines.length - 1] = last + '…'
  }
  return lines
}

function drawCover(context: SKRSContext2D, image: Image): void {
  const scale = Math.max(WIDTH / image.width, COVER_HEIGHT / image.height)
  const width = WIDTH / scale
  const height = COVER_HEIGHT / scale
  context.drawImage(image, (image.width - width) / 2, (image.height - height) / 2, width, height, 0, 0, WIDTH, COVER_HEIGHT)
}

async function drawCoverSection(context: SKRSContext2D, info: VideoInfo, cover?: Buffer): Promise<void> {
  const { loadImage, Path2D } = await import('@napi-rs/canvas')
  context.save()
  context.fillStyle = '#eef3f8'
  context.fillRect(0, 0, WIDTH, COVER_HEIGHT)
  context.fillStyle = '#00a1d6'
  context.font = '600 42px ' + FONT
  context.fillText('bilibili', 205, 175)
  if (cover) {
    try { drawCover(context, await loadImage(cover)) } catch { /* Keep metadata readable if a CDN image is corrupt. */ }
  }
  context.fillStyle = 'rgba(150, 150, 150, 0.67)'
  context.fillRect(0, COVER_HEIGHT - 50, WIDTH, 50)
  context.fillStyle = '#ffffff'
  context.font = '20px ' + FONT
  context.textBaseline = 'middle'
  const view = formatCount(info.view)
  const danmakuX = 146 + context.measureText(view).width
  for (const [path, x] of [[ICON_PLAY, 20], [ICON_DANMU, danmakuX]] as const) {
    context.save()
    context.translate(x, COVER_HEIGHT - 36)
    context.scale(22 / 24, 22 / 24)
    context.fill(new Path2D(path))
    context.restore()
  }
  context.fillText(view, 48, COVER_HEIGHT - 25)
  context.fillText(formatCount(info.danmu), danmakuX + 28, COVER_HEIGHT - 25)
  context.textAlign = 'right'
  context.fillText(info.duration.split(':').map(part => part.padStart(2, '0')).join(':'), WIDTH - 20, COVER_HEIGHT - 25)
  context.restore()
}

/** Koishi-style cover: playback statistics on the image, UP and upload time directly below it. */
export async function renderCover(info: VideoInfo, cover?: Buffer): Promise<Buffer> {
  const { createCanvas } = await import('@napi-rs/canvas')
  const measure = createCanvas(WIDTH, 1).getContext('2d')
  measure.font = '25px ' + FONT
  const timeWidth = measure.measureText(info.uploadTime).width
  measure.font = '500 25px ' + FONT
  const owner = wrap(measure, 'UP: ' + info.owner, WIDTH - 60 - timeWidth, 2)
  const height = COVER_HEIGHT + 48 + owner.length * 32
  const canvas = createCanvas(WIDTH, height)
  const context = canvas.getContext('2d')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, WIDTH, height)
  await drawCoverSection(context, info, cover)
  context.fillStyle = '#000000'
  context.font = '500 25px ' + FONT
  context.textBaseline = 'middle'
  for (let i = 0; i < owner.length; i++) context.fillText(owner[i], 20, COVER_HEIGHT + 40 + i * 32)
  context.fillStyle = '#333333'
  context.font = '25px ' + FONT
  context.textAlign = 'right'
  context.fillText(info.uploadTime, WIDTH - 20, (COVER_HEIGHT + height) / 2)
  return canvas.encode('png')
}

/** Native canvas packages include platform binaries; no browser, image host or installation script is needed. */
export async function renderCard(info: VideoInfo, summary: string, cover?: Buffer): Promise<Buffer> {
  const { createCanvas } = await import('@napi-rs/canvas')
  const measure = createCanvas(WIDTH, 1).getContext('2d')
  measure.font = '600 24px ' + FONT
  const title = wrap(measure, info.title, WIDTH - 48, 3)
  measure.font = '18px ' + FONT
  const desc = info.desc && info.desc !== info.title ? wrap(measure, '简介：' + info.desc, WIDTH - 48, 4) : []
  const summaryLines = summary ? wrap(measure, summary, WIDTH - 48, 12) : []
  const height = COVER_HEIGHT + 24 + title.length * 34 + 42 + 30
    + (desc.length ? 14 + desc.length * 27 : 0) + (summaryLines.length ? 18 + summaryLines.length * 28 : 0) + 52
  const canvas = createCanvas(WIDTH, height)
  const context = canvas.getContext('2d')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, WIDTH, height)
  await drawCoverSection(context, info, cover)
  let y = COVER_HEIGHT + 35
  context.fillStyle = '#172033'
  context.font = '600 24px ' + FONT
  for (const line of title) { context.fillText(line, 24, y); y += 34 }
  context.font = '18px ' + FONT
  context.fillStyle = '#4b5563'
  const owner = wrap(context, 'UP：' + info.owner, 290, 1)[0] ?? ''
  context.fillText(owner, 24, y + 6)
  context.font = '14px ' + FONT
  context.textAlign = 'right'
  context.fillText(info.uploadTime, WIDTH - 24, y + 6)
  context.textAlign = 'left'
  y += 42
  context.font = '16px ' + FONT
  context.fillText('点赞 ' + formatCount(info.like) + '   投币 ' + formatCount(info.coin) + '   收藏 ' + formatCount(info.favorite), 24, y - 5)
  y += 30
  context.font = '18px ' + FONT
  if (desc.length) {
    y += 8
    for (const line of desc) { context.fillText(line, 24, y); y += 27 }
  }
  if (summaryLines.length) {
    y += 16
    context.fillStyle = '#174a68'
    for (const line of summaryLines) { context.fillText(line, 24, y); y += 28 }
  }
  context.fillStyle = '#dfe7ef'
  context.fillRect(24, height - 43, WIDTH - 48, 1)
  context.font = '14px ' + FONT
  context.fillStyle = '#00a1d6'
  context.fillText('BILIBILI', 24, height - 19)
  context.textAlign = 'right'
  context.fillStyle = '#7b8796'
  context.fillText(info.bvid || 'av' + info.aid, WIDTH - 24, height - 19)
  return canvas.encode('png')
}

export async function renderQrcode(url: string, ttl: number): Promise<Buffer> {
  const { createCanvas } = await import('@napi-rs/canvas')
  const qr = qrcode(0, 'M')
  qr.addData(url)
  qr.make()
  const cell = 7
  const margin = 28
  const size = qr.getModuleCount() * cell + margin * 2
  const canvas = createCanvas(size, size + 106)
  const context = canvas.getContext('2d')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, size, size + 106)
  context.textAlign = 'center'
  context.fillStyle = '#00a1d6'
  context.font = '600 24px ' + FONT
  context.fillText('B站扫码登录', size / 2, 38)
  context.fillStyle = '#000000'
  for (let row = 0; row < qr.getModuleCount(); row++) {
    for (let col = 0; col < qr.getModuleCount(); col++) {
      if (qr.isDark(row, col)) context.fillRect(margin + col * cell, 54 + margin + row * cell, cell, cell)
    }
  }
  context.font = '17px ' + FONT
  context.fillStyle = '#4b5563'
  context.fillText(ttl + ' 秒内使用手机 B站 App 扫码并确认', size / 2, size + 82)
  return canvas.encode('png')
}

export async function matchCover(preview: Buffer, covers: { index: number; data: Buffer }[]): Promise<number | undefined> {
  const { createCanvas, loadImage } = await import('@napi-rs/canvas')
  const canvas = createCanvas(16, 9)
  const context = canvas.getContext('2d')
  const grid = (image: Image, card = false): Uint8ClampedArray => {
    context.clearRect(0, 0, 16, 9)
    let x = 0, y = 0, width = image.width, height = image.height
    // QQ miniapp previews include a header/footer around the 16:9 video thumbnail.
    if (card && image.width / image.height < 1.5) {
      width = image.width * 0.92
      height = Math.min(image.height, width * 9 / 16)
      x = image.width * 0.04
      y = Math.max(0, Math.min(image.height * 0.21, image.height - height))
    }
    context.drawImage(image, x, y, width, height, 0, 0, 16, 9)
    return context.getImageData(0, 0, 16, 9).data
  }
  const expected = grid(await loadImage(preview), true)
  let best: { index: number; score: number } | undefined
  for (const cover of covers) {
    try {
      const actual = grid(await loadImage(cover.data))
      let diff = 0, count = 0
      for (let y = 0; y < 9; y++) for (let x = 0; x < 16; x++) {
        // Ignore the overlay controls and caption at the edges of QQ previews.
        if (y >= 7 || (x >= 13 && y <= 1) || (x >= 7 && x <= 9 && y >= 3 && y <= 5)) continue
        for (let channel = 0; channel < 3; channel++) {
          const offset = (y * 16 + x) * 4 + channel
          diff += Math.abs(expected[offset] - actual[offset])
          count++
        }
      }
      const score = 1 - diff / (count * 255)
      if (!best || score > best.score) best = { index: cover.index, score }
    } catch { /* A corrupt candidate must not discard the other candidates. */ }
  }
  return best && best.score >= 0.72 ? best.index : undefined
}
