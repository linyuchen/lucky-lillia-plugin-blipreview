import { createCanvas, loadImage } from '@napi-rs/canvas'
import jsQR from 'jsqr'
import { expect, it } from 'vitest'
import type { VideoInfo } from '../src/api.js'
import { renderCard, renderCover, renderQrcode } from '../src/render.js'
import { QR_URL, VIDEO, solidPng } from './fixtures.js'

const info: VideoInfo = {
  bvid: VIDEO.bvid, aid: VIDEO.aid, cid: VIDEO.cid, title: VIDEO.title, desc: VIDEO.desc,
  coverUrl: VIDEO.pic, uploadTime: '2023/11/15 06:13', duration: '3:26',
  view: VIDEO.stat.view, danmu: VIDEO.stat.danmaku, like: VIDEO.stat.like,
  coin: VIDEO.stat.coin, share: VIDEO.stat.share, favorite: VIDEO.stat.favorite,
  owner: VIDEO.owner.name, ownerId: VIDEO.owner.mid,
}

async function readPng(png: Buffer) {
  const image = await loadImage(png)
  const context = createCanvas(image.width, image.height).getContext('2d')
  context.drawImage(image, 0, 0)
  return {
    width: image.width, height: image.height,
    region: (y: number, height: number) => Buffer.from(context.getImageData(0, y, image.width, height).data),
  }
}

it.each([
  { field: '播放', change: { view: 9876543 }, band: 'stats' },
  { field: '弹幕', change: { danmu: 87654 }, band: 'stats' },
  { field: '时长', change: { duration: '2:04:15' }, band: 'stats' },
  { field: 'UP 主', change: { owner: '另一位 UP' }, band: 'meta' },
  { field: '上传时间', change: { uploadTime: '2025/03/01 12:34' }, band: 'meta' },
])('draws $field into the corresponding image region', async ({ change, band }) => {
  const cover = solidPng()
  const original = await readPng(await renderCover(info, cover))
  const changed = await readPng(await renderCover({ ...info, ...change }, cover))
  expect([original.width, original.height]).toEqual([560, 395])
  expect([changed.width, changed.height]).toEqual([560, 395])
  expect(original.region(0, 265).equals(changed.region(0, 265))).toBe(true)
  expect(original.region(265, 50).equals(changed.region(265, 50))).toBe(band !== 'stats')
  expect(original.region(315, 80).equals(changed.region(315, 80))).toBe(band !== 'meta')
})

it('uses the same cover and statistics in the compact and full card', async () => {
  const cover = solidPng()
  const compact = await readPng(await renderCover(info, cover))
  const card = await readPng(await renderCard(info, '视频总结示例。', cover))
  expect(card.height).toBeGreaterThan(compact.height)
  expect(card.region(0, 315).equals(compact.region(0, 315))).toBe(true)
})

it('keeps the metadata image when the cover is corrupt or missing, and wraps long UP names', async () => {
  const missing = await renderCover(info)
  const corrupt = await renderCover(info, Buffer.from('not an image'))
  expect(corrupt.equals(missing)).toBe(true)
  const longOwner = await readPng(await renderCover({ ...info, owner: '一个需要换行显示的很长很长的UP主名字' }))
  expect(longOwner.width).toBe(560)
  expect(longOwner.height).toBe(427)
})

it('renders a PNG QR that an independent decoder reads as the exact B站 login URL', async () => {
  const png = await renderQrcode(QR_URL, 180)
  const image = await loadImage(png)
  const canvas = createCanvas(image.width, image.height)
  const context = canvas.getContext('2d')
  context.drawImage(image, 0, 0)
  const pixels = context.getImageData(0, 0, image.width, image.height)
  expect(jsQR(pixels.data, image.width, image.height)?.data).toBe(QR_URL)
})
