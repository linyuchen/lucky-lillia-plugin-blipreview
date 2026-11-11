import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, type TestApp } from '@luckylillia/plugin-sdk/testing'
import * as plugin from '../src/index.js'
import { fakeBili, json } from './fixtures.js'

let app: TestApp
let fake: ReturnType<typeof fakeBili>
beforeEach(async () => {
  fake = fakeBili()
  app = await createTestApp()
})
afterEach(async () => {
  await app.dispose()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const setup = (config: Partial<plugin.Config> = {}) => app.ctx.plugin(plugin, config)
const user = { userId: 'user', guildId: 'group' }
const saved = async () => JSON.parse(await readFile(join(app.dataDir, 'global/accounts/default.json'), 'utf8'))
const pollCalls = () => fake.calls.filter(call => call.url.pathname.endsWith('/poll'))

function success(): Response {
  const response = json({ code: 0, data: {
    code: 0, refresh_token: 'test-refresh-token',
    url: 'https://passport.biligame.com/crossDomain?SESSDATA=query%2Cvalue&bili_jct=test-csrf&DedeUserID=123456&Expires=1&gourl=ignored',
  } })
  response.headers.append('set-cookie', 'SESSDATA=header%2Cvalue; Path=/; HttpOnly')
  response.headers.append('set-cookie', 'sid=test-sid; Path=/')
  return response
}

describe('login permissions and cookie management', () => {
  it('lets an ordinary user request a QR by default', async () => {
    vi.useFakeTimers()
    const fiber = await setup()
    const bot = app.bot()
    const login = bot.receive('登录B站')
    await vi.waitFor(() => expect(bot.sent[0]?.content).toContain('data:image/png;base64,'))
    expect(fake.calls.filter(call => call.url.pathname.endsWith('/generate'))).toHaveLength(1)
    expect(app.ctx.commands.list().every(command => command.authority === 'everyone')).toBe(true)
    await fiber.dispose()
    await login
  })

  it('applies centrally configured permissions live and ignores legacy plugin administrator lists', async () => {
    const legacyConfig = { cookie: '', admins: ['test:user'] }
    await setup(legacyConfig)
    app.commands.permissions = [
      { owner: '', command: '登录B站', authority: 'owner' },
      { owner: '', command: '设置B站cookie', authority: 'owner' },
    ]
    app.commands.owners = ['test:alice']
    const bot = app.bot()
    expect((await bot.receive('登录B站'))[0]).toContain('权限')
    expect(fake.calls).toEqual([])
    expect((await bot.receive('设置B站cookie', { userId: 'user' }))[0]).toContain('权限')
    expect((await bot.receive('设置B站cookie', { userId: 'alice' }))[0]).toContain('包含 SESSDATA')
    expect((await app.bot({ platform: 'qq' }).receive('设置B站cookie', { userId: 'alice' }))[0]).toContain('权限')
    app.commands.permissions = []
    app.commands.owners = []
    expect((await bot.receive('设置B站cookie', { userId: 'user' }))[0]).toContain('包含 SESSDATA')
    expect((await bot.receive('设置B站cookie', { userId: 'alice' }))[0]).toContain('包含 SESSDATA')
  })

  it('persists manually pasted cookies, clears unrelated refresh tokens and survives reload', async () => {
    const config = { cookie: 'SESSDATA=config', refreshToken: 'old-refresh' }
    const fiber = await setup(config)
    const bot = app.bot()
    expect((await bot.receive('设置B站cookie SESSDATA=manual%2Cvalue; bili_jct=test-csrf', user))[0]).toContain('设置成功')
    expect(await saved()).toMatchObject({ cookie: 'SESSDATA=manual%2Cvalue; bili_jct=test-csrf', refreshToken: '' })
    await fiber.dispose()
    const beforeReload = fake.calls.length
    await setup(config)
    await vi.waitFor(() => expect(fake.calls.slice(beforeReload).find(call => call.url.pathname.endsWith('/nav'))?.headers.get('cookie'))
      .toBe('SESSDATA=manual%2Cvalue; bili_jct=test-csrf'))
    expect(await saved()).toMatchObject({ cookie: 'SESSDATA=manual%2Cvalue; bili_jct=test-csrf', refreshToken: '' })
    expect(bot.sent.map(message => message.content).join('')).not.toContain('manual%2Cvalue')
  })

  it('does not accept an incomplete cookie and does not register a disabled login command', async () => {
    await setup({ qrLogin: { enabled: false } })
    const bot = app.bot()
    expect((await bot.receive('设置B站cookie bili_jct=only-csrf', user))[0]).toContain('包含 SESSDATA')
    expect(app.ctx.commands.list().some(command => command.name === '登录B站')).toBe(false)
    expect(fake.calls).toEqual([])
  })

  it('does not send a late cookie-validation reply after unload', async () => {
    const fiber = await setup()
    fake.route = call => call.url.pathname.endsWith('/nav') ? new Promise((_, reject) => {
      call.init.signal!.addEventListener('abort', () => reject(call.init.signal!.reason), { once: true })
    }) : undefined
    const bot = app.bot()
    const command = bot.receive('设置B站cookie SESSDATA=test', user)
    await vi.waitFor(() => expect(fake.calls.some(call => call.url.pathname.endsWith('/nav'))).toBe(true))
    await fiber.dispose()
    await command
    expect(bot.sent).toEqual([])
  })
})

describe('QR login lifecycle', () => {
  it('handles scanned/confirmed states and persists encoded Cookie values without recalling the QR', async () => {
    vi.useFakeTimers()
    const legacyConfig = { cookie: 'SESSDATA=existing', qrLogin: { enabled: true, pollInterval: 1, timeout: 30, recall: true } }
    const fiber = await setup(legacyConfig)
    fake.polls = [json({ code: 0, data: { code: 86090 } }), success()]
    const bot = app.bot()
    bot.deleteMessage = vi.fn(async () => {})
    const login = bot.receive('/登录B站', user)
    await vi.waitFor(() => expect(bot.sent.length).toBe(1))
    expect(bot.sent[0].content).toContain('data:image/png;base64,')
    await vi.advanceTimersByTimeAsync(1000)
    expect(pollCalls()).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(2000)
    await vi.waitFor(() => expect(bot.sent.some(message => message.content.includes('已扫码'))).toBe(true))
    await vi.advanceTimersByTimeAsync(3000)
    await login
    expect(bot.sent.at(-1)?.content).toBe('B站登录成功，登录凭据已保存。')
    expect(bot.deleteMessage).not.toHaveBeenCalled()
    expect(await saved()).toMatchObject({
      cookie: 'SESSDATA=header%2Cvalue; bili_jct=test-csrf; DedeUserID=123456; sid=test-sid', refreshToken: 'test-refresh-token',
    })
    expect(fake.calls.filter(call => call.url.hostname === 'passport.bilibili.com').every(call => !call.headers.has('cookie'))).toBe(true)
    expect(bot.sent.map(message => message.content).join('')).not.toContain('123456')
    await fiber.dispose()
    const beforeReload = fake.calls.length
    await setup({ cookie: 'SESSDATA=existing' })
    await vi.waitFor(() => expect(fake.calls.slice(beforeReload).find(call => call.url.pathname.endsWith('/nav'))?.headers.get('cookie'))
      .toContain('header%2Cvalue'))
  })

  it('prevents overlapping QR logins and cancels the waiting QR on unload without changing credentials', async () => {
    vi.useFakeTimers()
    const fiber = await setup({ cookie: 'SESSDATA=existing' })
    const bot = app.bot()
    bot.deleteMessage = vi.fn(async () => {})
    const login = bot.receive('登录B站', user)
    await vi.waitFor(() => expect(bot.sent.length).toBe(1))
    expect((await bot.receive('登录B站', user))[0]).toContain('等待完成或超时')
    await fiber.dispose()
    await login
    await vi.advanceTimersByTimeAsync(180000)
    expect(pollCalls()).toHaveLength(0)
    expect(await saved()).toMatchObject({ cookie: 'SESSDATA=existing', refreshToken: '' })
    expect(bot.deleteMessage).not.toHaveBeenCalled()
  })

  it.each(['expired', 'timeout'] as const)('ends a QR login on %s without recalling the message', async reason => {
    vi.useFakeTimers()
    await setup()
    if (reason === 'expired') fake.polls = [json({ code: 0, data: { code: 86038 } })]
    const bot = app.bot()
    bot.deleteMessage = vi.fn(async () => {})
    const login = bot.receive('登录B站', user)
    await vi.waitFor(() => expect(bot.sent.length).toBe(1))
    await vi.advanceTimersByTimeAsync(reason === 'expired' ? 3000 : 180000)
    await login
    expect(bot.sent.at(-1)?.content).toContain(reason === 'expired' ? '已失效' : '已超时')
    expect(bot.deleteMessage).not.toHaveBeenCalled()
  })

  it('retries a failed poll and still completes the login', async () => {
    vi.useFakeTimers()
    await setup()
    let failed = false
    fake.route = call => {
      if (call.url.pathname.endsWith('/poll') && !failed) { failed = true; throw Object.assign(new Error('network'), { code: 'ECONNRESET' }) }
    }
    fake.polls = [success()]
    const bot = app.bot()
    const login = bot.receive('登录B站', user)
    await vi.waitFor(() => expect(bot.sent.length).toBe(1))
    await vi.advanceTimersByTimeAsync(6000)
    await login
    expect(pollCalls()).toHaveLength(2)
    expect(bot.sent.at(-1)?.content).toContain('登录成功')
  })

  it('cancels an in-flight poll on unload and does not send a late login result', async () => {
    vi.useFakeTimers()
    const fiber = await setup()
    fake.route = call => call.url.pathname.endsWith('/poll') ? new Promise((_, reject) => {
      call.init.signal!.addEventListener('abort', () => reject(call.init.signal!.reason), { once: true })
    }) : undefined
    const bot = app.bot()
    bot.deleteMessage = vi.fn(async () => {})
    const login = bot.receive('登录B站', user)
    await vi.waitFor(() => expect(bot.sent.length).toBe(1))
    await vi.advanceTimersByTimeAsync(3000)
    expect(pollCalls()).toHaveLength(1)
    await fiber.dispose()
    await login
    expect(bot.sent).toHaveLength(1)
    expect(bot.deleteMessage).not.toHaveBeenCalled()
    expect(pollCalls()[0].init.signal?.aborted).toBe(true)
  })

  it('does not persist a successful poll that arrives after the QR deadline', async () => {
    vi.useFakeTimers()
    await setup()
    fake.route = async call => {
      if (!call.url.pathname.endsWith('/poll')) return
      await new Promise(resolve => setTimeout(resolve, 181000))
      return success()
    }
    const bot = app.bot()
    const login = bot.receive('登录B站', user)
    await vi.waitFor(() => expect(bot.sent.length).toBe(1))
    await vi.advanceTimersByTimeAsync(184000)
    await login
    expect(bot.sent.at(-1)?.content).toContain('已超时')
    expect(await saved()).toMatchObject({ cookie: '', refreshToken: '' })
  })
})
