import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { h } from '@luckylillia/plugin-sdk'
import { createTestApp, type TestApp } from '@luckylillia/plugin-sdk/testing'
import * as Provider from 'lucky-lillia-aiprovider'
import * as plugin from '../src/index.js'
import { BVID, OTHER_BVID, VIDEO, fakeBili, json, solidPng } from './fixtures.js'

let app: TestApp
let fake: ReturnType<typeof fakeBili>

beforeEach(async () => { fake = fakeBili(); app = await createTestApp() })
afterEach(async () => { await app.dispose(); vi.unstubAllGlobals() })

const setup = (config: Partial<plugin.Config> = {}) => app.ctx.plugin(plugin, config)
const views = () => fake.calls.filter(call => call.url.pathname.endsWith('/view'))
const miniapp = (fields: Record<string, string>) => h('luckylillia:ark', { data: JSON.stringify({
  app: 'com.tencent.miniapp_01', desc: '哔哩哔哩', meta: { detail_1: { title: '哔哩哔哩', ...fields } },
}) }).toString()

async function addAi() {
  await app.ctx.plugin(Provider, { ais: [{ name: 'test-ai', baseUrl: 'https://ai.example.test/v1', apiKey: 'ai-test-key', models: ['summary-model'] }] })
  await vi.waitFor(() => expect(app.ctx.get('ai')).toBeTruthy())
}

describe('messages, commands and rendering', () => {
  it('previews video metadata and continues the middleware chain', async () => {
    await setup()
    let seen = 0
    app.ctx.on('bot/message', async (_, next) => { seen++; await next() })
    const bot = app.bot({ features: ['message.markdown'] })
    const replies = await bot.receive('看看这个 ' + BVID)
    expect(replies).toHaveLength(1)
    expect(replies[0]).toContain(VIDEO.title)
    expect(replies[0]).toContain('播放 12\\.3万')
    expect(replies[0]).toContain('弹幕 42')
    expect(replies[0]).toContain('点赞 678')
    expect(replies[0]).toContain('https://www.bilibili.com/video/' + BVID)
    expect(seen).toBe(1)
    expect(await bot.receive('普通聊天')).toEqual([])
    expect(seen).toBe(2)
  })

  it('ignores removed commands and applies normal preview cooldown to their text', async () => {
    await setup()
    const bot = app.bot()
    await bot.receive(BVID)
    expect(await bot.receive('/bili ' + BVID)).toEqual([])
    for (const command of ['bili', 'B站状态', 'B站退出', 'B站登录']) {
      expect(await bot.receive('/' + command)).toEqual([])
      expect(app.ctx.commands.list().some(entry => entry.name === command)).toBe(false)
    }
    expect(bot.sent).toHaveLength(1)
  })

  it('automatically previews videos even when the legacy switch is disabled', async () => {
    const legacyConfig = { autoPreview: false, cacheDuration: 60 }
    await setup(legacyConfig)
    const bot = app.bot()
    expect(await bot.receive(BVID)).toHaveLength(1)
    expect(await bot.receive('/bili ' + BVID)).toEqual([])
  })

  it('uses a PNG card on NTQQ and host markdown on a capable official bot', async () => {
    await setup()
    const nt = app.bot({ platform: 'luckylillia' })
    const official = app.bot({ platform: 'qq', features: ['message.markdown'] })
    const images = await nt.receive(BVID)
    expect(images[0]).toMatch(/^<img src="data:image\/png;base64,/)
    expect(images[0]).toContain('\nhttps://www.bilibili.com/video/' + BVID)
    const markdown = (await official.receive('<at id="bot"/> ' + BVID, { guildId: 'group' }))[0]
    expect(markdown).toMatch(/^<markdown>/)
    expect(markdown).toContain('![封面 #560px #315px]')
    expect(markdown).not.toContain('qq:rawmarkdown')
    expect(fake.calls.find(call => call.url.hostname === 'i0.hdslb.com')?.headers.has('cookie')).toBe(false)
  })

  it('escapes remote titles/markdown and includes video statistics', async () => {
    fake.video.title = '标题 <at id="all"/> [假链接](https://evil.test)'
    await setup()
    const content = (await app.bot({ features: ['message.markdown'] }).receive(BVID))[0]
    expect(content).toContain('\\&lt;at')
    expect(content).toContain('\\[假链接\\]')
    expect(content).not.toContain('<at id=')
    expect(content).toContain('播放 12\\.3万')
    expect(content).toContain('弹幕 42')
    expect(content).toContain('点赞 678')
  })

  it('uses an image card and video link for official bots without markdown capability', async () => {
    await setup()
    const content = (await app.bot({ platform: 'qq' }).receive(BVID))[0]
    expect(content).not.toContain('<markdown>')
    expect(content).toContain('<img ')
    expect(content).toContain('https://www.bilibili.com/video/' + BVID)
  })

  it('does not preview quotes, media URLs or messages sent by itself', async () => {
    await setup()
    const bot = app.bot()
    expect(await bot.receive(h('quote', { id: 'quoted' }, BVID).toString() + '好看')).toEqual([])
    expect(await bot.receive(h.image('https://gchat.qpic.cn/' + BVID).toString())).toEqual([])
    expect(await bot.receive(BVID, { userId: bot.selfId })).toEqual([])
    expect(views()).toHaveLength(0)
  })
})

describe('deduplication and failures', () => {
  it('deduplicates BV and av within a conversation but isolates bots and channels', async () => {
    await setup()
    const first = app.bot({ selfId: 'first' })
    const second = app.bot({ selfId: 'second' })
    expect(await first.receive(BVID, { guildId: 'g' })).toHaveLength(1)
    expect(await first.receive('av170001', { guildId: 'g' })).toEqual([])
    expect(await second.receive(BVID, { guildId: 'g' })).toHaveLength(1)
    expect(await first.receive(BVID, { guildId: 'another' })).toHaveLength(1)
  })

  it('coalesces simultaneous requests and suppresses simultaneous duplicate replies', async () => {
    await setup()
    const bot = app.bot()
    await Promise.all([bot.receive(BVID), bot.receive(BVID), bot.receive(BVID)])
    expect(bot.sent).toHaveLength(1)
    expect(views()).toHaveLength(1)
  })

  it('does not cache a failed API request or send', async () => {
    await setup()
    const bot = app.bot()
    fake.route = call => call.url.pathname.endsWith('/view') ? json({ code: -352 }) : undefined
    expect(await bot.receive(BVID)).toEqual([])
    fake.route = undefined
    vi.spyOn(bot, 'sendMessage').mockRejectedValueOnce(new Error('upload failed'))
    expect(await bot.receive(BVID)).toEqual([])
    expect(await bot.receive(BVID)).toHaveLength(1)
  })

  it('does not preview unavailable videos', async () => {
    fake.route = call => call.url.pathname.endsWith('/view') ? json({ code: -404 }) : undefined
    await setup()
    expect(await app.bot().receive(BVID)).toEqual([])
  })

  it('cancels an in-flight API call and removes commands when unloaded', async () => {
    const fiber = await setup()
    fake.route = call => call.url.pathname.endsWith('/view') ? new Promise((_, reject) => {
      call.init.signal!.addEventListener('abort', () => reject(call.init.signal!.reason), { once: true })
    }) : undefined
    const bot = app.bot()
    const request = bot.receive(BVID)
    await vi.waitFor(() => expect(views()).toHaveLength(1))
    await fiber.dispose()
    await request
    expect(bot.sent).toEqual([])
    expect(app.ctx.commands.list().filter(command => ['登录B站', '设置B站cookie'].includes(command.name))).toEqual([])
  })
})

describe('short links and miniapp cards', () => {
  it('never sends B站 credentials to b23 redirect requests', async () => {
    await setup({ cookie: 'SESSDATA=bili-secret' })
    expect(await app.bot().receive('https://b23.tv/abc')).toHaveLength(1)
    expect(fake.calls.find(call => call.url.hostname === 'b23.tv')?.headers.has('cookie')).toBe(false)
    expect(views()[0].headers.get('cookie')).toBe('SESSDATA=bili-secret')
    expect(views()[0].init.redirect).toBe('error')
  })

  it('rejects redirects outside B站', async () => {
    fake.route = call => call.url.hostname === 'b23.tv' ? new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }) : undefined
    await setup()
    expect(await app.bot().receive('https://b23.tv/abc')).toEqual([])
    expect(fake.calls.some(call => call.url.hostname === '127.0.0.1')).toBe(false)
  })

  it('uses the miniapp direct link without searching by title', async () => {
    await setup()
    const content = miniapp({ desc: VIDEO.title, qqdocurl: 'https://b23.tv/card' })
    expect(await app.bot().receive(content)).toHaveLength(1)
    expect(fake.calls.some(call => call.url.pathname.endsWith('/search/type'))).toBe(false)
  })

  it('requires exact titles and signs title searches with WBI', async () => {
    await setup({ cacheDuration: 0 })
    const bot = app.bot()
    fake.candidates = [{ type: 'video', bvid: BVID, title: '标题不相同', pic: VIDEO.pic }]
    expect(await bot.receive(miniapp({ desc: VIDEO.title }))).toEqual([])
    fake.candidates[0].title = '<em>' + VIDEO.title + '</em>'
    expect(await bot.receive(miniapp({ desc: VIDEO.title }))).toHaveLength(1)
    const searches = fake.calls.filter(call => call.url.pathname.endsWith('/search/type'))
    expect(searches.every(call => /^[0-9a-f]{32}$/.test(call.url.searchParams.get('w_rid') ?? ''))).toBe(true)
  })

  it('disambiguates equal titles using QQ preview pixels without forwarding credentials', async () => {
    await setup({ cookie: 'SESSDATA=bili-secret' })
    fake.candidates = [
      { type: 'video', bvid: BVID, title: VIDEO.title, pic: 'https://i0.hdslb.com/blue.png' },
      { type: 'video', bvid: OTHER_BVID, title: VIDEO.title, pic: 'https://i0.hdslb.com/red.png' },
    ]
    fake.route = call => {
      if (call.url.hostname === 'gchat.qpic.cn' || call.url.pathname === '/red.png') return new Response(new Uint8Array(solidPng('#ff0000')), { headers: { 'Content-Type': 'image/png' } })
      if (call.url.pathname === '/blue.png') return new Response(new Uint8Array(solidPng('#0000ff')), { headers: { 'Content-Type': 'image/png' } })
      if (call.url.searchParams.get('bvid') === OTHER_BVID) return json({ code: 0, data: { ...VIDEO, bvid: OTHER_BVID } })
    }
    const reply = await app.bot().receive(miniapp({ desc: VIDEO.title, preview: 'https://gchat.qpic.cn/p.png' }))
    expect(reply[0]).toContain(OTHER_BVID)
    expect(fake.calls.filter(call => ['gchat.qpic.cn', 'i0.hdslb.com'].includes(call.url.hostname)).every(call => !call.headers.has('cookie'))).toBe(true)
  })
})

describe('summaries via the optional AI service', () => {
  it('works without AI installed and can add the service after the preview plugin starts', async () => {
    await setup({ summaryMode: 'llm', cacheDuration: 0, model: { ai: 'test-ai', model: 'summary-model' }, cookie: 'SESSDATA=bili-secret' })
    const bot = app.bot({ features: ['message.markdown'] })
    expect((await bot.receive(BVID))[0]).toContain('请先配置并启用 AI 服务')
    await addAi()
    const response = (await bot.receive(BVID))[0]
    expect(response).toContain('视频介绍了星空摄影的准备工作。')
    const request = fake.calls.find(call => call.url.hostname === 'ai.example.test')!
    expect(request.headers.get('authorization')).toBe('Bearer ai-test-key')
    expect(request.headers.has('cookie')).toBe(false)
    expect(request.body.model).toBe('summary-model')
    expect(request.body.messages[1].content).toContain('三脚架')
    expect(fake.calls.find(call => call.url.hostname === 'aisubtitle.hdslb.com')?.headers.has('cookie')).toBe(false)
    expect(fake.calls.find(call => call.url.pathname.endsWith('/player/wbi/v2'))?.url.searchParams.has('w_rid')).toBe(true)
  })

  it('omits a summary for a video without subtitles but distinguishes an expired login', async () => {
    await addAi()
    await setup({ summaryMode: 'llm', cacheDuration: 0 })
    fake.subtitles = []
    const bot = app.bot({ features: ['message.markdown'] })
    expect((await bot.receive(BVID))[0]).not.toContain('AI 总结')
    fake.loggedIn = false
    expect((await bot.receive(BVID))[0]).toContain('B站未登录')
  })

  it('uses only one subtitle track instead of concatenating manual and AI copies', async () => {
    await addAi()
    await setup({ summaryMode: 'llm' })
    fake.subtitles.push({ lan: 'ai-zh', subtitle_url: 'https://aisubtitle.hdslb.com/duplicate.json' })
    await app.bot().receive(BVID)
    expect(fake.calls.filter(call => call.url.hostname === 'aisubtitle.hdslb.com')).toHaveLength(1)
  })

  it('signs official summary requests and keeps previews when the summary API fails', async () => {
    await setup({ summaryMode: 'official', cacheDuration: 0 })
    const bot = app.bot({ features: ['message.markdown'] })
    expect((await bot.receive(BVID))[0]).toContain('官方总结示例。')
    const request = fake.calls.find(call => call.url.pathname.endsWith('/conclusion/get'))!
    expect(request.url.searchParams.get('up_mid')).toBe(String(VIDEO.owner.mid))
    expect(request.url.searchParams.has('w_rid')).toBe(true)
    fake.route = call => call.url.pathname.endsWith('/conclusion/get') ? json({ code: -352 }) : undefined
    expect((await bot.receive(BVID))[0]).toContain(VIDEO.title)
  })
})
