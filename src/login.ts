import { h, type Context, type HttpResponse, type Session } from '@luckylillia/plugin-sdk'
import { BiliApiError, errorSummary, isBiliUrl, type BiliClient, type Envelope } from './api.js'
import type { Config } from './config.js'
import { cookieValue, loginCookieHeaders, LOGIN_COOKIE_KEYS, type CredentialStore } from './credentials.js'
import { renderQrcode } from './render.js'

const QR_POLL_INTERVAL_MS = 3000
const QR_TIMEOUT_SECONDS = 180

interface Ticket { url: string; qrcode_key: string }
interface PollData { code: number; url?: string; refresh_token?: string }

export interface LoginControl {
  readonly running: boolean
  start(task: (controller: AbortController) => Promise<void>): Promise<void>
  cancel(): Promise<void>
}

export interface QrResult {
  state: 'success' | 'expired' | 'error'
  message: string
  loggedIn?: boolean
}

interface QrObserver {
  generated(url: string, expiresAt: number): Promise<void>
  scanned(): Promise<void>
}

/** Preserve escaped cookie values; URLSearchParams would decode SESSDATA's embedded %2C. */
export function loginCookies(response: HttpResponse<Envelope<PollData>>): string {
  const cookies: Record<string, string> = {}
  const query = (response.data.data?.url ?? '').split('?')[1]?.split('#')[0] ?? ''
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=')
    const key = pair.slice(0, eq)
    if (eq > 0 && LOGIN_COOKIE_KEYS.includes(key)) cookies[key] = pair.slice(eq + 1)
  }
  for (const [key, value] of loginCookieHeaders(response.headers)) cookies[key] = value
  return LOGIN_COOKIE_KEYS.filter(key => cookies[key]).map(key => key + '=' + cookies[key]).join('; ')
}

function sleep(ctx: Context, ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise(resolve => {
    const finish = () => {
      cancel()
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const cancel = ctx.timeout(finish, ms)
    signal.addEventListener('abort', finish, { once: true })
    if (signal.aborted) finish()
  })
}

function textArgument(markup: string): string {
  return h.parse(markup).filter(element => element.type === 'text').map(element => String(element.attrs.content ?? '')).join('')
}

/** Shared by chat and WebUI; only this function exchanges a QR ticket for saved credentials. */
export async function runQrLogin(
  ctx: Context, client: BiliClient, credentials: CredentialStore,
  signal: AbortSignal, observer: QrObserver,
): Promise<QrResult> {
  const deadline = Date.now() + QR_TIMEOUT_SECONDS * 1000
  const response = await client.loginRequest<Ticket>('generate', {}, signal)
  const ticket = response.data.data
  if (response.data.code !== 0) throw new BiliApiError(response.data.code)
  if (!ticket?.qrcode_key || !isBiliUrl(ticket.url)) throw new Error('二维码响应无效')
  signal.throwIfAborted()
  await observer.generated(ticket.url, deadline)
  let scanned = false
  while (!signal.aborted && Date.now() < deadline) {
    await sleep(ctx, Math.min(QR_POLL_INTERVAL_MS, deadline - Date.now()), signal)
    signal.throwIfAborted()
    if (Date.now() >= deadline) break
    let poll: HttpResponse<Envelope<PollData>>
    try { poll = await client.loginRequest<PollData>('poll', { qrcode_key: ticket.qrcode_key }, signal) }
    catch (error) {
      if (signal.aborted) throw error
      ctx.logger('blipreview').warn('轮询 B站扫码状态失败：%s', errorSummary(error))
      continue
    }
    signal.throwIfAborted()
    if (Date.now() >= deadline) break
    if (poll.data.code !== 0) throw new BiliApiError(poll.data.code)
    const data = poll.data.data
    if (!data || typeof data.code !== 'number') throw new Error('扫码状态响应无效')
    if (data.code === 86101) continue
    if (data.code === 86090) {
      if (!scanned) { scanned = true; await observer.scanned() }
      continue
    }
    if (data.code === 86038) return { state: 'expired', message: '二维码已失效，请重新发送「登录B站」。' }
    if (data.code !== 0) throw new BiliApiError(data.code)
    const cookie = loginCookies(poll)
    if (!cookieValue(cookie, 'SESSDATA')) return { state: 'error', message: '扫码已确认，但 B站没有返回完整登录凭据，请重新登录。' }
    await credentials.save(cookie, data.refresh_token ?? '', signal)
    try {
      const loggedIn = await client.checkLogin()
      return { state: 'success', loggedIn, message: loggedIn
        ? 'B站登录成功，登录凭据已保存。' : '登录凭据已保存，但 B站判定为未登录，请重新扫码。' }
    } catch { return { state: 'success', message: '登录凭据已保存，暂时无法验证 B站登录状态。' } }
  }
  signal.throwIfAborted()
  return { state: 'expired', message: '二维码已超时，请重新发送「登录B站」。' }
}

export function registerLogin(ctx: Context, client: BiliClient, credentials: CredentialStore, config: Config): LoginControl {
  const logger = ctx.logger('blipreview')
  const reply = (text: string) => client.signal.aborted ? undefined : h.text(text)
  let running: { controller: AbortController; task: Promise<void> } | undefined
  const control: LoginControl = {
    get running() { return !!running },
    start(work) {
      if (running) throw new Error('已有一个 B站扫码登录正在进行')
      const controller = new AbortController()
      const task = Promise.resolve().then(() => work(controller)).finally(() => {
        if (running?.controller === controller) running = undefined
      })
      running = { controller, task }
      return task
    },
    async cancel() {
      const current = running
      current?.controller.abort()
      await current?.task
    },
  }
  ctx.effect(() => () => control.cancel())

  async function qrLogin(session: Session, controller: AbortController): Promise<void> {
    const signal = AbortSignal.any([controller.signal, client.signal])
    try {
      const result = await runQrLogin(ctx, client, credentials, signal, {
        async generated(url) {
          let image: Buffer | undefined
          try { image = await renderQrcode(url, QR_TIMEOUT_SECONDS) }
          catch (error) { logger.warn('生成 B站登录二维码失败：%s', errorSummary(error)) }
          signal.throwIfAborted()
          await session.send(image ? h.image(image, 'image/png')
            : h.text('B站扫码登录，' + QR_TIMEOUT_SECONDS + ' 秒内有效。请用手机 B站 App 打开：\n' + url))
        },
        async scanned() { await session.send(h.text('已扫码，请在手机 B站 App 上确认登录。')) },
      })
      signal.throwIfAborted()
      if (!signal.aborted) await session.send(h.text(result.message))
    } catch (error) {
      if (!signal.aborted) {
        logger.warn('B站扫码登录失败：%s', errorSummary(error))
        await session.send(h.text('B站扫码登录失败，请稍后重试。'))
      }
    }
  }

  if (config.qrLogin.enabled) {
    ctx.command('登录B站', '在聊天窗口发送二维码，使用手机 B站 App 扫码登录').action(async ({ session }) => {
      if (running) return reply('已有一个 B站扫码登录正在进行，请等待完成或超时后再试。')
      await control.start(controller => qrLogin(session, controller))
    })
  }

  ctx.command('设置B站cookie [cookies:text]', '导入 B站登录 Cookie', { hidden: true }).action(async (_, raw: string = '') => {
    if (running) return reply('请先完成扫码登录，或等待二维码超时后再设置 Cookie。')
    const cookie = textArgument(raw)
    if (!cookieValue(cookie, 'SESSDATA')) return reply('请在指令后附上包含 SESSDATA 的完整 B站 Cookie。')
    try {
      // A manually pasted cookie has no matching refresh token from an earlier QR login.
      await credentials.save(cookie, '', client.signal)
    } catch (error) {
      if (!client.signal.aborted) logger.warn('保存 B站 Cookie 失败：%s', errorSummary(error))
      return reply('保存 B站 Cookie 失败，请检查插件数据目录是否可写。')
    }
    try {
      return reply(await client.checkLogin() ? '设置成功，B站已登录，登录凭据已保存。' : 'Cookie 已保存，但 B站判定为未登录，可能不完整或已过期。')
    } catch { return reply('Cookie 已保存，暂时无法验证 B站登录状态。') }
  })

  return control
}
