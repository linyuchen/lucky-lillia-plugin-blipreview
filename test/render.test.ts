import { createCanvas, loadImage } from '@napi-rs/canvas'
import jsQR from 'jsqr'
import { expect, it } from 'vitest'
import { renderQrcode } from '../src/render.js'
import { QR_URL } from './fixtures.js'

it('renders a PNG QR that an independent decoder reads as the exact B站 login URL', async () => {
  const png = await renderQrcode(QR_URL, 180)
  const image = await loadImage(png)
  const canvas = createCanvas(image.width, image.height)
  const context = canvas.getContext('2d')
  context.drawImage(image, 0, 0)
  const pixels = context.getImageData(0, 0, image.width, image.height)
  expect(jsQR(pixels.data, image.width, image.height)?.data).toBe(QR_URL)
})
