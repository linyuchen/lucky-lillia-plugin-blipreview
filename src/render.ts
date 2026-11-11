import qrcode from 'qrcode-generator'
import type { Image, SKRSContext2D } from '@napi-rs/canvas'
import type { VideoInfo } from './api.js'
import { isImageUrl } from './api.js'

const FONT = '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "Noto Sans SC", "WenQuanYi Micro Hei", sans-serif'
const WIDTH = 560

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

export function formatMarkdown(info: VideoInfo, summary: string): string {
  const cover = isImageUrl(info.coverUrl) ? info.coverUrl.replace(/[()<>\s]/g, char => encodeURIComponent(char)) : ''
  return [cover ? '![封面 #560px #315px](' + cover + ')' : '', '**' + escapeMarkdown(info.title) + '**',
    'UP：' + escapeMarkdown(info.owner), escapeMarkdown(stats(info)),
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
  const scale = Math.max(WIDTH / image.width, 315 / image.height)
  const width = WIDTH / scale
  const height = 315 / scale
  context.drawImage(image, (image.width - width) / 2, (image.height - height) / 2, width, height, 0, 0, WIDTH, 315)
}

/** Native canvas packages include platform binaries; no browser, image host or installation script is needed. */
export async function renderCard(info: VideoInfo, summary: string, cover?: Buffer): Promise<Buffer> {
  const { createCanvas, loadImage } = await import('@napi-rs/canvas')
  const measure = createCanvas(WIDTH, 1).getContext('2d')
  measure.font = '600 24px ' + FONT
  const title = wrap(measure, info.title, WIDTH - 48, 3)
  measure.font = '18px ' + FONT
  const desc = info.desc && info.desc !== info.title ? wrap(measure, '简介：' + info.desc, WIDTH - 48, 4) : []
  const summaryLines = summary ? wrap(measure, summary, WIDTH - 48, 12) : []
  const height = 315 + 24 + title.length * 34 + 42 + 30
    + (desc.length ? 14 + desc.length * 27 : 0) + (summaryLines.length ? 18 + summaryLines.length * 28 : 0) + 52
  const canvas = createCanvas(WIDTH, height)
  const context = canvas.getContext('2d')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, WIDTH, height)
  context.fillStyle = '#eef3f8'
  context.fillRect(0, 0, WIDTH, 315)
  context.fillStyle = '#00a1d6'
  context.font = '600 42px ' + FONT
  context.fillText('bilibili', 205, 175)
  if (cover) {
    try { drawCover(context, await loadImage(cover)) } catch { /* Keep a readable card if a CDN image is corrupt. */ }
  }
  context.fillStyle = 'rgba(25, 31, 42, 0.72)'
  context.fillRect(0, 273, WIDTH, 42)
  context.fillStyle = '#ffffff'
  context.font = '18px ' + FONT
  context.fillText('播放 ' + formatCount(info.view) + '   弹幕 ' + formatCount(info.danmu), 22, 300)
  context.textAlign = 'right'
  context.fillText(info.duration, WIDTH - 22, 300)
  context.textAlign = 'left'
  let y = 350
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
