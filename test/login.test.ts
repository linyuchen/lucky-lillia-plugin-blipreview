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
  app.commands.owners = ['test:user']
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

describe('login permissions', () => {
  it('only registers QR login and restricts it to configured owners by default', async () => {
    vi.useFakeTimers()
    const fiber = await setup()
    const bot = app.bot()
    const visitor = { userId: 'visitor', guildId: 'group' }
    expect((await bot.receive('登录B站', visitor))[0]).toContain('权限')
    expect(await bot.receive('设置B站cookie SESSDATA=manual')).toEqual([])
    expect(fake.calls).toEqual([])
    await vi.waitFor(async () => {
      expect(await saved()).toMatchObject({ cookie: '', refreshToken: '' })
    })
    const login = bot.receive('登录B站')
    await vi.waitFor(() => expect(bot.sent.some(message => message.content.includes('data:image/png;base64,'))).toBe(true))
    expect(fake.calls.filter(call => call.url.pathname.endsWith('/generate'))).toHaveLength(1)
    expect(app.ctx.commands.list()).toMatchObject([{ name: '登录B站', authority: 'owner', defaultAuthority: 'owner' }])
    await fiber.dispose()
    await login
  })

  it('applies centrally configured permissions live and ignores legacy plugin administrator lists', async () => {
    vi.useFakeTimers()
    const legacyConfig = { cookie: '', admins: ['test:user'] }
    const fiber = await setup(legacyConfig)
    app.commands.owners = ['test:alice']
    const bot = app.bot()
    expect((await bot.receive('登录B站'))[0]).toContain('权限')
    expect((await app.bot({ platform: 'qq' }).receive('登录B站', { userId: 'alice' }))[0]).toContain('权限')
    expect(fake.calls).toEqual([])
    const login = bot.receive('登录B站', { userId: 'alice' })
    await vi.waitFor(() => expect(bot.sent.some(message => message.content.includes('data:image/png;base64,'))).toBe(true))
    app.commands.permissions = [
      { owner: '', command: '登录B站', authority: 'everyone' },
    ]
    app.commands.owners = []
    expect((await bot.receive('登录B站'))[0]).toContain('已有一个')
    expect(app.ctx.commands.list()).toMatchObject([{ name: '登录B站', authority: 'everyone', defaultAuthority: 'owner' }])
    app.commands.permissions = []
    expect((await bot.receive('登录B站'))[0]).toContain('权限')
    await fiber.dispose()
    await login
  })

  it('does not register chat commands when QR login is disabled', async () => {
    await setup({ qrLogin: { enabled: false } })
    const bot = app.bot()
    expect(await bot.receive('登录B站', user)).toEqual([])
    expect(app.ctx.commands.list()).toEqual([])
    expect(fake.calls).toEqual([])
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
