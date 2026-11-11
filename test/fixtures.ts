import { createCanvas } from '@napi-rs/canvas'
import { vi } from 'vitest'

export const BVID = 'BV17x411w7KC'
export const OTHER_BVID = 'BV1xx411c7mD'
export const VIDEO = {
  bvid: BVID, aid: 170001, cid: 279786, title: '测试视频：一起看星星', desc: '介绍星空摄影的方法。',
  pic: 'https://i0.hdslb.com/bfs/archive/cover.png', pubdate: 1700000000, duration: 206,
  stat: { view: 123456, danmaku: 42, like: 678, coin: 123, favorite: 345, share: 12 },
  owner: { name: '测试 UP', mid: 12345 },
}
export const WBI = {
  img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
  sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
}
export const QR_URL = 'https://account.bilibili.com/h5/account-h5/auth/scan-web?navhide=1&callback=close&qrcode_key=test-ticket&from='

export function solidPng(color = '#3675ba'): Buffer {
  const canvas = createCanvas(160, 90)
  const context = canvas.getContext('2d')
  context.fillStyle = color
  context.fillRect(0, 0, 160, 90)
  return canvas.toBuffer('image/png')
}

export interface Call { url: URL; headers: Headers; init: RequestInit; body?: any }
export const json = (data: unknown, init?: ResponseInit): Response => new Response(JSON.stringify(data), {
  ...init, headers: { 'Content-Type': 'application/json', ...init?.headers },
})

export function fakeBili() {
  const state = {
    calls: [] as Call[],
    video: structuredClone(VIDEO),
    loggedIn: true,
    candidates: [] as Record<string, any>[],
    subtitles: [{ lan: 'zh-Hans', subtitle_url: '//aisubtitle.hdslb.com/subtitle.json' }],
    official: '官方总结示例。',
    polls: [] as Response[],
    route: undefined as ((call: Call) => Response | undefined | Promise<Response | undefined>) | undefined,
  }
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    init.signal?.throwIfAborted()
    const call: Call = {
      url: new URL(input instanceof Request ? input.url : input.toString()), headers: new Headers(init.headers), init,
      body: init.body instanceof URLSearchParams ? Object.fromEntries(init.body)
        : typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    }
    state.calls.push(call)
    const override = await state.route?.(call)
    if (override) return override
    const { hostname, pathname } = call.url
    if (hostname === 'api.bilibili.com') {
      if (pathname.endsWith('/nav')) return json({ code: state.loggedIn ? 0 : -101, data: { isLogin: state.loggedIn, wbi_img: WBI } })
      if (pathname.endsWith('/view')) return json({ code: 0, data: state.video })
      if (pathname.endsWith('/wbi/search/type')) return json({ code: 0, data: { result: state.candidates } })
      if (pathname.endsWith('/player/wbi/v2')) return json({ code: 0, data: { subtitle: { subtitles: state.subtitles } } })
      if (pathname.endsWith('/conclusion/get')) return json({ code: 0, data: { model_result: { summary: state.official } } })
    }
    if (hostname === 'b23.tv') return new Response(null, { status: 302, headers: { location: 'https://www.bilibili.com/video/' + BVID } })
    if (hostname === 'aisubtitle.hdslb.com') return json({ body: [{ content: '拍摄星空需要三脚架。' }, { content: '远离光污染可以看见银河。' }] })
    if (hostname === 'i0.hdslb.com' || hostname === 'gchat.qpic.cn') return new Response(new Uint8Array(solidPng()), { headers: { 'Content-Type': 'image/png' } })
    if (hostname === 'passport.bilibili.com') {
      if (pathname.endsWith('/cookie/info')) return json({ code: 0, data: { refresh: false, timestamp: Date.now() } })
      if (pathname.endsWith('/generate')) return json({ code: 0, data: { url: QR_URL, qrcode_key: 'test-ticket' } })
      if (pathname.endsWith('/poll')) return state.polls.shift() ?? json({ code: 0, data: { code: 86101 } })
    }
    if (hostname === 'ai.example.test' && pathname === '/v1/chat/completions') {
      return json({ model: call.body?.model, choices: [{ message: { content: '视频介绍了星空摄影的准备工作。' } }] })
    }
    throw new Error('Unexpected request: ' + call.url.origin + pathname)
  }))
  return state
}
