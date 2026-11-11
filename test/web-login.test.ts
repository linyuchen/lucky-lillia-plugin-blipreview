import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, type TestApp } from '@luckylillia/plugin-sdk/testing'
import { BiliClient } from '../src/api.js'
import { Config } from '../src/config.js'
import { CredentialStore } from '../src/credentials.js'
import { registerLogin } from '../src/login.js'
import { WebLogin, webLoginPath } from '../src/web-login.js'
import { CookieRefresher } from '../src/refresh.js'
import { fakeBili, json } from './fixtures.js'

let app: TestApp
let fake: ReturnType<typeof fakeBili>
let web: WebLogin
let credentials: CredentialStore
const id = 'web-login-attempt-one'

beforeEach(async () => {
  fake = fakeBili()
  app = await createTestApp()
})
afterEach(async () => { await web?.dispose(); await credentials?.settled(); await app.dispose(); vi.useRealTimers(); vi.unstubAllGlobals() })

async function setup() {
  return app.ctx.plugin({
    name: 'web-login-test', inject: ['http', 'timer', 'bots', 'commands'],
    apply(ctx) {
      const config = Config({})
      const controller = new AbortController()
      ctx.effect(() => () => controller.abort())
      credentials = new CredentialStore(ctx.storage, config.account, config)
      ctx.effect(() => () => credentials.settled())
      const client = new BiliClient(ctx.http, credentials, controller.signal)
      const refresher = new CookieRefresher(ctx, client, credentials)
      web = new WebLogin(ctx, client, credentials, config, registerLogin(ctx, client, credentials, config), refresher)
      ctx.effect(() => () => refresher.settled())
      ctx.effect(() => () => web.dispose())
    },
  })
}

function request(action: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', signal?: AbortSignal) {
  return web.fetch(new Request('http://localhost' + webLoginPath('default') + '/' + action, {
    method, signal, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  }))
}
async function call(action: string, body?: unknown) {
  const response = await request(action, body)
  expect(response.headers.get('cache-control')).toBe('no-store')
  return { status: response.status, ...await response.json() }
}
function success() {
  return json({ code: 0, data: { code: 0, refresh_token: 'private-refresh-token',
    url: 'https://passport.bilibili.com/callback?SESSDATA=private%2Cweb-cookie&bili_jct=test-csrf' } }, {
    headers: { 'Set-Cookie': 'SESSDATA=private%2Cweb-cookie; Path=/; HttpOnly' },
  })
}

describe('WebUI login', () => {
  it('requires an explicit maintenance POST and reports a forced renewal without exposing credentials', async () => {
    await setup()
    expect((await call('refresh')).status).toBe(405)
    expect((await call('refresh', {})).status).toBe(400)
    expect((await call('refresh', { force: 'true' })).status).toBe(400)
    expect(fake.calls).toEqual([])
    await credentials.save('SESSDATA=private-old; bili_jct=private-old-csrf', 'private-old-token')
    fake.route = call => {
      if (call.url.pathname.startsWith('/correspond/1/')) return new Response('<div id="1-name">0123456789abcdef0123456789abcdef</div>')
      if (call.url.pathname.endsWith('/cookie/refresh')) {
        const response = json({ code: 0, data: { status: 0, refresh_token: 'private-new-token' } })
        response.headers.append('set-cookie', 'SESSDATA=private-new; Path=/; HttpOnly')
        response.headers.append('set-cookie', 'bili_jct=private-new-csrf; Path=/')
        return response
      }
      if (call.url.pathname.endsWith('/confirm/refresh')) return json({ code: 0 })
    }
    const result = await call('refresh', { force: true })
    expect(result).toMatchObject({ status: 200, success: true, data: {
      hasCredentials: true, hasRefreshToken: true, cookieChanged: true, refreshTokenChanged: true,
      loggedIn: true, pendingConfirmation: false,
    } })
    expect(JSON.stringify(result)).not.toMatch(/private|SESSDATA|bili_jct/)
    expect((await credentials.get()).refreshToken).toBe('private-new-token')
  })

  it('shows logged-out status without contacting B站 when there are no saved credentials', async () => {
    await setup()
    expect(await call('status')).toMatchObject({ status: 200, data: { account: 'default', loggedIn: false, hasCredentials: false } })
    expect(fake.calls).toEqual([])
    expect((await request('start')).status).toBe(405)
    expect((await call('start', { id: '../bad' })).status).toBe(400)
  })

  it('reports QR progress without secrets and supplies saved credentials through the form endpoint', async () => {
    vi.useFakeTimers()
    await setup()
    fake.polls = [json({ code: 0, data: { code: 86090 } }), success()]
    const started = await call('start', { id })
    expect(started.data).toMatchObject({ state: 'waiting', id, expiresAt: expect.any(Number) })
    expect(started.data.image).toMatch(/^data:image\/png;base64,/)
    expect((await call('start', { id })).data.image).toBe(started.data.image)
    expect(fake.calls.filter(call => call.url.pathname.endsWith('/generate'))).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(3000)
    expect((await call('status')).data.state).toBe('scanned')
    await vi.advanceTimersByTimeAsync(3000)
    await vi.waitFor(async () => expect((await credentials.get()).cookie).toContain('private%2Cweb-cookie'))
    await vi.waitFor(async () => expect((await call('status')).data.state).toBe('success'))
    const status = (await call('status')).data
    expect(status).toMatchObject({ loggedIn: true, hasCredentials: true })
    expect(status.image).toBeUndefined()
    expect(JSON.stringify(status)).not.toMatch(/private|SESSDATA|refresh_token|qrcode_key/)
    expect((await call('credentials')).data).toEqual(await credentials.get())
    expect((await call('credentials')).data).toMatchObject({ cookie: expect.stringContaining('private%2Cweb-cookie'), refreshToken: 'private-refresh-token' })
    expect(fake.calls.filter(call => call.url.hostname === 'passport.bilibili.com').every(call => !call.headers.has('cookie'))).toBe(true)
  })

  it('reads current shared credentials without contacting B站 and returns empty fields after logout', async () => {
    await setup()
    await credentials.save('SESSDATA=manual', 'manual-refresh')
    expect((await call('credentials')).data).toEqual({ cookie: 'SESSDATA=manual', refreshToken: 'manual-refresh' })
    expect(fake.calls).toEqual([])
    expect((await call('credentials', {})).status).toBe(405)
    await call('logout', {})
    expect((await call('credentials')).data).toEqual({ cookie: '', refreshToken: '' })
    await web.dispose()
    expect((await call('credentials')).status).toBe(503)
  })

  it('rejects overlapping web/chat logins and ignores cancellation from a stale tab', async () => {
    vi.useFakeTimers()
    await setup()
    await call('start', { id })
    const bot = app.bot()
    expect((await call('refresh', { force: true })).status).toBe(409)
    expect((await call('start', { id: 'different-attempt' })).status).toBe(409)
    expect((await bot.receive('登录B站'))[0]).toContain('已有一个')
    expect((await bot.receive('设置B站cookie SESSDATA=other'))[0]).toContain('请先完成扫码')
    expect((await call('cancel', { id: 'different-attempt' })).data.state).toBe('waiting')
    expect((await call('cancel', { id })).data).toMatchObject({ state: 'cancelled', busy: false })
    await vi.advanceTimersByTimeAsync(180000)
    expect(fake.calls.filter(call => call.url.pathname.endsWith('/poll'))).toEqual([])
  })

  it('does not save a late successful response after cancelling an in-flight poll', async () => {
    vi.useFakeTimers()
    await setup()
    let complete!: (response: Response) => void
    fake.route = call => call.url.pathname.endsWith('/poll') ? new Promise(resolve => { complete = resolve }) : undefined
    await call('start', { id })
    await vi.advanceTimersByTimeAsync(3000)
    const cancelling = call('cancel', { id })
    await vi.waitFor(() => expect(fake.calls.find(call => call.url.pathname.endsWith('/poll'))?.init.signal?.aborted).toBe(true))
    complete(success())
    expect((await cancelling).data.state).toBe('cancelled')
    expect(await credentials.get()).toEqual({ cookie: '', refreshToken: '' })
  })

  it.each(['expired', 'timeout'] as const)('removes the QR when it is %s and allows a new login', async reason => {
    vi.useFakeTimers()
    await setup()
    if (reason === 'expired') fake.polls = [json({ code: 0, data: { code: 86038 } })]
    await call('start', { id })
    await vi.advanceTimersByTimeAsync(reason === 'expired' ? 3000 : 180000)
    const status = (await call('status')).data
    expect(status.state).toBe('expired')
    expect(status.image).toBeUndefined()
    expect((await call('start', { id: 'next-web-attempt' })).data.state).toBe('waiting')
  })

  it('cancels an outstanding web QR and clears the profile on logout', async () => {
    vi.useFakeTimers()
    await setup()
    await credentials.save('SESSDATA=previous', 'old-refresh')
    await call('start', { id })
    expect((await call('logout', {})).data).toMatchObject({ state: 'idle', loggedIn: false, hasCredentials: false })
    expect(await credentials.get()).toEqual({ cookie: '', refreshToken: '' })
    await vi.advanceTimersByTimeAsync(180000)
    expect(fake.calls.filter(call => call.url.pathname.endsWith('/poll'))).toEqual([])
  })

  it('handles a failed QR generation without leaking the upstream error or blocking another attempt', async () => {
    await setup()
    fake.route = call => call.url.pathname.endsWith('/generate') ? json({ code: -352 }) : undefined
    expect((await call('start', { id })).data).toMatchObject({ state: 'error', busy: false })
    fake.route = undefined
    expect((await call('start', { id: 'retry-web-attempt' })).data.state).toBe('waiting')
  })

  it('stops polling and rejects new actions after disposal', async () => {
    vi.useFakeTimers()
    await setup()
    await call('start', { id })
    await web.dispose()
    await vi.advanceTimersByTimeAsync(180000)
    expect(fake.calls.filter(call => call.url.pathname.endsWith('/poll'))).toEqual([])
    expect((await call('start', { id: 'disposed-attempt' })).status).toBe(503)
    expect(await credentials.get()).toEqual({ cookie: '', refreshToken: '' })
  })
})
