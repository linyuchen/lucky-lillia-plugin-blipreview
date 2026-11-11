import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, type TestApp } from '@luckylillia/plugin-sdk/testing'
import { BiliClient } from '../src/api.js'
import { CredentialStore } from '../src/credentials.js'
import { CookieRefresher, registerAutoRefresh } from '../src/refresh.js'
import * as plugin from '../src/index.js'
import { BVID, fakeBili, json, type Call } from './fixtures.js'

const HOUR = 3600000
const DAY = 24 * HOUR
const OLD = { cookie: 'SESSDATA=old%2Cvalue; bili_jct=old-csrf; DedeUserID=123; sid=old-sid; buvid3=device', refreshToken: 'old+refresh&token=%2F' }
const NEW = { cookie: 'SESSDATA=new%2Cvalue; bili_jct=new-csrf; DedeUserID=123; sid=new-sid; buvid3=device', refreshToken: 'new-refresh-token' }
const CSRF = 'b0cc8411ded2f9db2cff2edb3123acac'
let app: TestApp
let fake: ReturnType<typeof fakeBili>
let store: CredentialStore
let client: BiliClient
let refresher: CookieRefresher
let controller: AbortController
let required: boolean

function refreshed() {
  const response = json({ code: 0, data: { status: 0, refresh_token: NEW.refreshToken } })
  for (const cookie of ['SESSDATA=new%2Cvalue', 'bili_jct=new-csrf', 'DedeUserID=123', 'sid=new-sid', 'irrelevant=ignored']) {
    response.headers.append('set-cookie', cookie + '; Path=/; Domain=bilibili.com; HttpOnly; Secure')
  }
  return response
}

function flow(call: Call): Response | undefined {
  if (call.url.pathname.endsWith('/cookie/info')) return json({ code: 0, data: { refresh: required, timestamp: Date.now() - 120000 } })
  if (call.url.pathname.startsWith('/correspond/1/')) return new Response('<html><div class="token" id = \'1-name\'>\n' + CSRF + '\n</div></html>')
  if (call.url.pathname.endsWith('/cookie/refresh')) return refreshed()
  if (call.url.pathname.endsWith('/confirm/refresh')) return json({ code: 0 })
}

const calls = (path: string) => fake.calls.filter(call => call.url.pathname.endsWith(path))
const persisted = async () => JSON.parse(await readFile(join(app.dataDir, 'global/accounts/default.json'), 'utf8'))

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-10T00:00:00Z'))
  required = true
  fake = fakeBili()
  fake.route = flow
  app = await createTestApp()
})
afterEach(async () => {
  await app.dispose()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function setup(initial = OLD, schedule = false) {
  return app.ctx.plugin({
    name: 'refresh-test', inject: ['http', 'timer'],
    apply(ctx) {
      controller = new AbortController()
      store = new CredentialStore(ctx.storage, 'default', initial)
      client = new BiliClient(ctx.http, store, controller.signal)
      refresher = schedule ? registerAutoRefresh(ctx, client, store) : new CookieRefresher(ctx, client, store)
      ctx.effect(() => async () => { controller.abort(); await refresher.settled(); await store.settled() })
    },
  })
}

describe('B站 Cookie renewal protocol', () => {
  it('performs an explicit real exchange even when a fresh login is not due for automatic renewal', async () => {
    required = false
    await setup()
    await refresher.check()
    expect(calls('/cookie/refresh')).toHaveLength(0)
    expect((await store.snapshot()).refresh?.nextCheckAt).toBe(Date.now() + DAY)
    await Promise.all([refresher.check(true), refresher.check(true)])
    expect(calls('/cookie/refresh')).toHaveLength(1)
    expect(calls('/confirm/refresh')).toHaveLength(1)
    expect(await store.get()).toEqual(NEW)
  })

  it('queues a forced exchange after an already running automatic check', async () => {
    required = false
    await setup()
    let release!: () => void
    const wait = new Promise<void>(resolve => { release = resolve })
    fake.route = async call => {
      if (call.url.pathname.endsWith('/cookie/info') && calls('/cookie/info').length === 1) await wait
      return flow(call)
    }
    const automatic = refresher.check()
    await vi.waitFor(() => expect(calls('/cookie/info')).toHaveLength(1))
    const manual = refresher.check(true)
    release()
    await Promise.all([automatic, manual])
    expect(calls('/cookie/info')).toHaveLength(2)
    expect(calls('/cookie/refresh')).toHaveLength(1)
    expect(await store.get()).toEqual(NEW)
  })

  it('uses form-encoded old credentials, persists the rotated pair, then confirms with the new Cookie and old token', async () => {
    await setup()
    let confirmed = false
    fake.route = async call => {
      if (call.url.pathname.endsWith('/confirm/refresh')) {
        // Invalidating the old login is safe only after both new values have reached disk.
        expect(await persisted()).toMatchObject({ ...NEW, refresh: { pendingToken: OLD.refreshToken } })
        expect(call.headers.get('cookie')).toBe(NEW.cookie)
        expect(call.body).toEqual({ csrf: 'new-csrf', refresh_token: OLD.refreshToken })
        confirmed = true
      }
      return flow(call)
    }
    await refresher.check()
    expect(confirmed).toBe(true)
    expect(await store.get()).toEqual(NEW)
    expect((await store.snapshot()).refresh).toEqual({ nextCheckAt: Date.now() + DAY })
    const info = calls('/cookie/info')[0]
    expect(info.url.searchParams.get('csrf')).toBe('old-csrf')
    expect(info.headers.get('cookie')).toBe(OLD.cookie)
    const correspond = fake.calls.find(call => call.url.pathname.startsWith('/correspond/1/'))!
    expect(correspond.url.pathname).toMatch(/^\/correspond\/1\/[a-f0-9]{256}$/)
    expect(correspond.headers.get('cookie')).toBe(OLD.cookie)
    const refresh = calls('/cookie/refresh')[0]
    expect(refresh.init.method).toBe('POST')
    expect(refresh.headers.get('content-type')).toBe('application/x-www-form-urlencoded')
    expect(refresh.headers.get('cookie')).toBe(OLD.cookie)
    expect(refresh.body).toEqual({ csrf: 'old-csrf', refresh_csrf: CSRF, source: 'main_web', refresh_token: OLD.refreshToken })
    expect(refresh.init.body?.toString()).toContain('old%2Brefresh%26token%3D%252F')
    expect(fake.calls.every(call => call.init.redirect === 'error')).toBe(true)
    expect(client.publicHttp.config.timeout).toBe(30000)
    expect(client.publicHttp.config.headers).not.toHaveProperty('Cookie')
    expect(await new CredentialStore({ dir: async () => join(app.dataDir, 'global') }, 'default', OLD).get()).toEqual(NEW)
    await client.video({ bvid: BVID })
    expect(calls('/view')[0].headers.get('cookie')).toBe(NEW.cookie)
    await client.image('https://i0.hdslb.com/cover.png')
    expect(fake.calls.at(-1)?.headers.has('cookie')).toBe(false)
  })

  it('checks unchanged credentials at most daily, including after reload', async () => {
    required = false
    await setup()
    await refresher.check()
    await Promise.all([refresher.check(), refresher.check()])
    const reloaded = new CredentialStore({ dir: async () => join(app.dataDir, 'global') }, 'default', OLD)
    await new CookieRefresher(app.ctx, new BiliClient(app.ctx.http, reloaded, controller.signal), reloaded).check()
    expect(calls('/cookie/info')).toHaveLength(1)
    expect(calls('/cookie/refresh')).toHaveLength(0)
    expect(await store.get()).toEqual(OLD)
    vi.setSystemTime(Date.now() + DAY)
    await refresher.check()
    expect(calls('/cookie/info')).toHaveLength(2)
  })

  it.each([
    { cookie: '', refreshToken: '' },
    { cookie: OLD.cookie, refreshToken: '' },
    { cookie: 'SESSDATA=only-session', refreshToken: OLD.refreshToken },
    { cookie: 'bili_jct=only-csrf', refreshToken: OLD.refreshToken },
  ])('leaves incomplete or manually imported credentials usable without attempting renewal: %j', async initial => {
    await setup(initial)
    await refresher.check()
    expect(fake.calls).toEqual([])
    expect(await store.get()).toEqual(initial)
  })

  it('coalesces concurrent checks from plugin entries sharing an account', async () => {
    await setup()
    await store.ready
    const shared = new CredentialStore({ dir: async () => join(app.dataDir, 'global') }, 'default', OLD)
    const other = new CookieRefresher(app.ctx, new BiliClient(app.ctx.http, shared, controller.signal), shared)
    await Promise.all([refresher.check(), refresher.check(), other.check()])
    expect(calls('/cookie/info')).toHaveLength(1)
    expect(calls('/cookie/refresh')).toHaveLength(1)
    expect(calls('/confirm/refresh')).toHaveLength(1)
    expect(await shared.get()).toEqual(NEW)
  })
})

describe('renewal failures and concurrent login changes', () => {
  it.each(['network', 'page', 'session', 'csrf', 'token', 'uid', 'timestamp', 'status'] as const)('preserves the old login on an incomplete or failed %s response and retries later', async failure => {
    await setup()
    fake.route = call => {
      if (failure === 'network' && call.url.pathname.endsWith('/cookie/info')) throw Object.assign(new Error('sensitive-cookie-' + OLD.refreshToken), { code: 'ECONNRESET' })
      if (failure === 'page' && call.url.pathname.startsWith('/correspond/1/')) return new Response('<html>error</html>')
      if (failure === 'timestamp' && call.url.pathname.endsWith('/cookie/info')) return json({ code: 0, data: { refresh: true, timestamp: 'invalid' } })
      if (call.url.pathname.endsWith('/cookie/refresh')) {
        if (failure === 'token') return json({ code: 0, data: { status: 0 } })
        if (failure === 'status') return json({ code: 0, data: { status: 1, refresh_token: NEW.refreshToken } })
        const reply = refreshed()
        if (failure === 'session') reply.headers.append('set-cookie', 'SESSDATA=; Max-Age=0')
        if (failure === 'csrf') reply.headers.append('set-cookie', 'bili_jct=; Max-Age=0')
        if (failure === 'uid') reply.headers.append('set-cookie', 'DedeUserID=456')
        return reply
      }
      return flow(call)
    }
    await refresher.check()
    expect(await store.get()).toEqual(OLD)
    expect(calls('/confirm/refresh')).toHaveLength(0)
    expect((await store.snapshot()).refresh?.nextCheckAt).toBe(Date.now() + HOUR)
    const count = fake.calls.length
    await refresher.check()
    expect(fake.calls).toHaveLength(count)
    fake.route = flow
    vi.setSystemTime(Date.now() + HOUR)
    await refresher.check()
    expect(await store.get()).toEqual(NEW)
  })

  it.each([-101, -111, 86095])('backs off on an expired or mismatched login (%i) without clearing it', async code => {
    await setup()
    fake.route = call => call.url.pathname.endsWith('/cookie/info') ? json({ code, message: OLD.cookie }) : flow(call)
    await refresher.check()
    expect(await store.get()).toEqual(OLD)
    expect((await store.snapshot()).refresh?.nextCheckAt).toBe(Date.now() + DAY)
    expect(calls('/cookie/refresh')).toHaveLength(0)
  })

  it('keeps new credentials on failed confirmation and resumes with the old token after a restart', async () => {
    await setup()
    fake.route = call => call.url.pathname.endsWith('/confirm/refresh') ? json({ code: 503 }) : flow(call)
    await refresher.check()
    expect(await store.get()).toEqual(NEW)
    expect((await store.snapshot()).refresh).toEqual({ nextCheckAt: Date.now() + HOUR, pendingToken: OLD.refreshToken })
    const reloaded = new CredentialStore({ dir: async () => join(app.dataDir, 'global') }, 'default', OLD)
    fake.route = flow
    vi.setSystemTime(Date.now() + HOUR)
    await new CookieRefresher(app.ctx, new BiliClient(app.ctx.http, reloaded, controller.signal), reloaded).check()
    expect(calls('/cookie/refresh')).toHaveLength(1)
    expect(calls('/confirm/refresh')).toHaveLength(2)
    expect(calls('/confirm/refresh')[1].body.refresh_token).toBe(OLD.refreshToken)
    expect(calls('/confirm/refresh')[1].headers.get('cookie')).toBe(NEW.cookie)
    expect((await reloaded.snapshot()).refresh?.pendingToken).toBeUndefined()
  })

  it('recovers when B站 applied a confirmation but the successful response was lost', async () => {
    await setup()
    fake.route = call => call.url.pathname.endsWith('/confirm/refresh') ? json({ code: -400 }) : flow(call)
    await refresher.check()
    expect((await store.snapshot()).refresh?.pendingToken).toBe(OLD.refreshToken)
    required = false
    vi.setSystemTime(Date.now() + HOUR)
    await refresher.check()
    expect(await store.get()).toEqual(NEW)
    expect((await store.snapshot()).refresh?.pendingToken).toBeUndefined()
    expect(calls('/cookie/info')).toHaveLength(2)
  })

  it.each(['clear', 'replace', 'clear-and-restore'] as const)('discards a late renewal response after a manual %s in a shared entry', async action => {
    await setup()
    await store.ready
    const shared = new CredentialStore({ dir: async () => join(app.dataDir, 'global') }, 'default', OLD)
    await shared.ready
    fake.route = async call => {
      if (call.url.pathname.endsWith('/cookie/refresh')) {
        if (action === 'replace') await shared.save('SESSDATA=another-login', 'another-token')
        else {
          await shared.save('')
          if (action === 'clear-and-restore') await shared.save(OLD.cookie, OLD.refreshToken)
        }
      }
      return flow(call)
    }
    await refresher.check()
    expect(await store.get()).toEqual(action === 'replace' ? { cookie: 'SESSDATA=another-login', refreshToken: 'another-token' }
      : action === 'clear' ? { cookie: '', refreshToken: '' } : OLD)
    expect(calls('/confirm/refresh')).toHaveLength(0)
    expect((await store.snapshot()).refresh).toBeUndefined()
  })

  it('does not submit a refresh when a logout occurs during the CSRF request', async () => {
    await setup()
    fake.route = async call => {
      if (call.url.pathname.startsWith('/correspond/1/')) await store.save('')
      return flow(call)
    }
    await refresher.check()
    expect(await store.get()).toEqual({ cookie: '', refreshToken: '' })
    expect(calls('/cookie/refresh')).toHaveLength(0)
  })

  it('does not invalidate the old login if the rotated credentials cannot be persisted', async () => {
    await setup()
    vi.spyOn(store, 'replace').mockRejectedValueOnce(new Error('disk unavailable'))
    await refresher.check()
    expect(await store.get()).toEqual(OLD)
    expect(calls('/confirm/refresh')).toHaveLength(0)
  })

  it('cancels pending requests on unload and refuses late writes', async () => {
    const fiber = await setup()
    fake.route = call => call.url.pathname.endsWith('/cookie/refresh') ? new Promise((_, reject) => {
      call.init.signal!.addEventListener('abort', () => reject(call.init.signal!.reason), { once: true })
    }) : flow(call)
    const task = refresher.check()
    await vi.waitFor(() => expect(calls('/cookie/refresh')).toHaveLength(1))
    await fiber.dispose()
    await task
    expect(calls('/cookie/refresh')[0].init.signal?.aborted).toBe(true)
    expect(await store.get()).toEqual(OLD)
    expect((await store.snapshot()).refresh).toBeUndefined()
    expect(calls('/confirm/refresh')).toHaveLength(0)
  })
})

describe('automatic scheduling', () => {
  it('renews existing logins on plugin startup and validates using the new Cookie', async () => {
    await app.ctx.plugin(plugin, OLD)
    await vi.waitFor(() => expect(calls('/nav').length).toBe(1))
    expect(calls('/cookie/refresh')).toHaveLength(1)
    expect(calls('/nav')[0].headers.get('cookie')).toBe(NEW.cookie)
  })

  it('picks up later QR logins on the hourly timer and stops checking after unload', async () => {
    vi.useRealTimers()
    vi.useFakeTimers()
    const fiber = await setup({ cookie: '', refreshToken: '' }, true)
    await store.save(OLD.cookie, OLD.refreshToken)
    expect(fake.calls).toEqual([])
    await vi.advanceTimersByTimeAsync(HOUR)
    await refresher.check()
    expect(await store.get()).toEqual(NEW)
    const count = fake.calls.length
    await vi.advanceTimersByTimeAsync(23 * HOUR)
    await refresher.check()
    expect(fake.calls).toHaveLength(count)
    await fiber.dispose()
    await vi.advanceTimersByTimeAsync(2 * DAY)
    expect(fake.calls).toHaveLength(count)
  })
})
