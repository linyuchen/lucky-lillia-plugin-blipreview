import { createHash } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { h } from '@luckylillia/plugin-sdk'
import { createTestApp, type TestApp } from '@luckylillia/plugin-sdk/testing'
import * as plugin from '../src/index.js'
import { uploadQQImage } from '../src/qq-media.js'
import { BVID, VIDEO, fakeBili, fakeQQMedia, solidPng } from './fixtures.js'

let app: TestApp
let fake: ReturnType<typeof fakeBili>
let media: ReturnType<typeof fakeQQMedia>

beforeEach(async () => {
  fake = fakeBili()
  media = fakeQQMedia(fake)
  app = await createTestApp()
})
afterEach(async () => { await app.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const official = () => app.bot({ platform: 'qq', features: ['message.markdown'], internal: media })

it('uploads valid PNG bytes with matching hashes and MIME type, and releases only its own material', async () => {
  const png = solidPng()
  const image = await uploadQQImage(app.ctx, official(), png, new AbortController().signal)
  expect(media.prepareMediaImage).toHaveBeenCalledExactlyOnceWith({
    file_name: expect.stringMatching(/^blipreview-[a-f0-9]{32}\.png$/),
    file_size: png.length, content_type: 'image/png',
    md5: createHash('md5').update(png).digest('hex'), sha1: createHash('sha1').update(png).digest('hex'),
  })
  const put = fake.calls.find(call => call.url.hostname === 'qq-upload.example.test')!
  expect(put.init.method).toBe('PUT')
  expect(Buffer.from(put.init.body as Uint8Array)).toEqual(png)
  expect(put.headers.get('content-type')).toBe('image/png')
  expect(put.headers.has('authorization')).toBe(false)
  expect(put.headers.has('cookie')).toBe(false)
  expect(media.completeMediaImage).toHaveBeenCalledExactlyOnceWith({ upload_id: 'upload-1', md5: createHash('md5').update(png).digest('hex') })
  expect(image.url).toBe('qqbot-media://image/v1/preview-1')
  expect(media.deleteMediaImage).not.toHaveBeenCalled()
  await image.dispose()
  await image.dispose()
  expect(media.deleteMediaImage).toHaveBeenCalledExactlyOnceWith('image-1')
})

it.each([undefined, 'group-1'])('keeps the material until its single Markdown reply finishes (guildId=%s)', async guildId => {
  await app.ctx.plugin(plugin, { cookie: 'SESSDATA=private-bili-cookie' })
  const bot = official()
  let finish!: () => void
  const sending = new Promise<void>(resolve => { finish = resolve })
  const originalSend = bot.sendMessage.bind(bot)
  const send = vi.spyOn(bot, 'sendMessage').mockImplementation(async (...args) => { await sending; return originalSend(...args) })
  const task = bot.receive(BVID, { guildId })
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
  expect(media.deleteMediaImage).not.toHaveBeenCalled()
  finish()
  const replies = await task
  expect(replies).toHaveLength(1)
  expect(h.parse(replies[0]).map(element => element.type)).toEqual(['markdown'])
  expect(replies[0]).toContain('![封面 #560px #395px](qqbot-media://image/v1/preview-1)')
  expect(replies[0]).toContain(VIDEO.title)
  expect(replies[0]).not.toMatch(/点赞|投币|收藏/)
  expect(replies[0]).not.toContain('<img ')
  expect(media.deleteMediaImage).toHaveBeenCalledExactlyOnceWith('image-1')
  expect(fake.calls.find(call => call.url.hostname === 'qq-upload.example.test')?.headers.has('cookie')).toBe(false)
})

it('deletes the material after a failed send and allows the next attempt without a duplicate fallback reply', async () => {
  await app.ctx.plugin(plugin)
  const bot = official()
  const send = vi.spyOn(bot, 'sendMessage').mockRejectedValueOnce(new Error('send failed'))
  expect(await bot.receive(BVID)).toEqual([])
  expect(send).toHaveBeenCalledTimes(1)
  expect(media.deleteMediaImage).toHaveBeenCalledTimes(1)
  expect(await bot.receive(BVID)).toHaveLength(1)
  expect(send).toHaveBeenCalledTimes(2)
})

it('does not resend a successful reply when cleanup fails', async () => {
  await app.ctx.plugin(plugin)
  media.deleteMediaImage.mockRejectedValueOnce(new Error('cleanup failed'))
  const bot = official()
  expect(await bot.receive(BVID)).toHaveLength(1)
  expect(await bot.receive(BVID)).toEqual([])
  expect(bot.sent).toHaveLength(1)
})

it('uses one basic Markdown preview when material upload is unavailable or at capacity', async () => {
  await app.ctx.plugin(plugin, { cacheDuration: 0 })
  const bot = official()
  media.prepareMediaImage.mockRejectedValueOnce(Object.assign(new Error('quota exceeded'), { code: 40035007 }))
  const content = (await bot.receive(BVID))[0]
  expect(h.parse(content).map(element => element.type)).toEqual(['markdown'])
  expect(content).toContain(VIDEO.pic)
  expect(content).toContain('UP：测试 UP')
  expect(content).toContain('播放 12\\.3万')
  expect(content).toContain('弹幕 42')
  expect(media.completeMediaImage).not.toHaveBeenCalled()
  expect(media.deleteMediaImage).not.toHaveBeenCalled()
  expect(await bot.receive(BVID)).toHaveLength(1)
})

it('rejects corrupt upload checksums before completing the material', async () => {
  fake.route = call => call.url.hostname === 'qq-upload.example.test' ? new Response('', { headers: { ETag: '"wrong"' } }) : undefined
  await expect(uploadQQImage(app.ctx, official(), solidPng(), new AbortController().signal)).rejects.toThrow('ETag')
  expect(media.completeMediaImage).not.toHaveBeenCalled()
})

it('cleans up an invalid completed reference and never exposes the temporary preview URL', async () => {
  media.completeMediaImage.mockResolvedValueOnce({ image_id: 'image-1', url: 'https://invalid.test/', ttl: 1, preview_url: 'https://private.test/?secret=preview' })
  await expect(uploadQQImage(app.ctx, official(), solidPng(), new AbortController().signal)).rejects.toThrow('图片引用')
  expect(media.deleteMediaImage).toHaveBeenCalledExactlyOnceWith('image-1')
})

it('disposes a completed upload if the plugin was unloaded before the reply could be sent', async () => {
  const fiber = await app.ctx.plugin(plugin)
  let finish!: () => void
  const completing = new Promise<void>(resolve => { finish = resolve })
  media.completeMediaImage.mockImplementationOnce(async () => {
    await completing
    return { image_id: 'image-1', url: 'qqbot-media://image/v1/preview-1', ttl: 7776000, preview_url: '' }
  })
  const bot = official()
  const task = bot.receive(BVID)
  await vi.waitFor(() => expect(media.completeMediaImage).toHaveBeenCalledTimes(1))
  await fiber.dispose()
  finish()
  expect(await task).toEqual([])
  expect(media.deleteMediaImage).toHaveBeenCalledExactlyOnceWith('image-1')
})
