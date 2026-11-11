import type { Context, WebUIServer } from '@luckylillia/plugin-sdk'
import type { Config } from './config.js'
import { errorSummary, type BiliClient } from './api.js'
import type { CredentialStore } from './credentials.js'
import { runQrLogin, type LoginControl } from './login.js'
import { renderQrcode } from './render.js'
import type { CookieRefresher } from './refresh.js'

type State = 'idle' | 'generating' | 'waiting' | 'scanned' | 'success' | 'expired' | 'cancelled' | 'error'
interface Progress { state: State; id?: string; image?: string; expiresAt?: number; message?: string }
interface Attempt {
  id: string
  cancelled: boolean
  controller?: AbortController
  ready: Promise<void>
  task: Promise<void>
}

class LoginRequestError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}

export const webLoginPath = (account: string): string => '/api/blipreview/login/' + encodeURIComponent(account)
const pending = (state: State) => ['generating', 'waiting', 'scanned'].includes(state)

/** Progress stays free of secrets; the authenticated credentials endpoint fills the login form. */
export class WebLogin {
  private progress: Progress = { state: 'idle' }
  private attempt?: Attempt
  private disposed = false
  private checked?: { cookie: string; at: number; loggedIn: boolean | null }

  constructor(
    private readonly ctx: Context,
    private readonly client: BiliClient,
    private readonly credentials: CredentialStore,
    private readonly config: Config,
    private readonly control: LoginControl,
    private readonly refresher?: CookieRefresher,
  ) {}

  async status() {
    const { cookie } = await this.credentials.get()
    if (this.checked && this.checked.cookie !== cookie && !pending(this.progress.state)) this.progress = { state: 'idle' }
    if (!cookie) this.checked = { cookie, at: Date.now(), loggedIn: false }
    else if (!pending(this.progress.state) && (!this.checked || this.checked.cookie !== cookie || Date.now() - this.checked.at > 60000)) {
      let loggedIn: boolean | null = null
      try { loggedIn = await this.client.checkLogin() } catch { /* Retain saved credentials when verification is unavailable. */ }
      if ((await this.credentials.get()).cookie === cookie) this.checked = { cookie, at: Date.now(), loggedIn }
    }
    return this.snapshot(!!cookie)
  }

  private snapshot(hasCredentials?: boolean) {
    return { ...this.progress, account: this.config.account, busy: this.control.running,
      loggedIn: this.checked?.loggedIn ?? null, hasCredentials: hasCredentials ?? !!this.checked?.cookie }
  }

  async start(id: string, requestSignal?: AbortSignal) {
    if (this.disposed || this.client.signal.aborted) throw new LoginRequestError('插件已停止，请重新启用后扫码。', 503)
    if (!/^[a-zA-Z0-9_-]{8,80}$/.test(id)) throw new LoginRequestError('无效的扫码请求')
    if (this.control.running) {
      if (this.attempt?.id !== id || !pending(this.progress.state)) throw new LoginRequestError('已有一个 B站扫码登录正在进行，请先完成或取消。', 409)
      await this.attempt.ready
      if (!pending(this.progress.state)) await this.attempt.task
      return this.snapshot()
    }
    let ready!: () => void
    const attempt: Attempt = { id, cancelled: false, ready: new Promise(resolve => { ready = resolve }), task: Promise.resolve() }
    this.attempt = attempt
    this.progress = { state: 'generating', id, message: '正在生成二维码…' }
    const abort = () => { attempt.cancelled = true; attempt.controller?.abort() }
    requestSignal?.addEventListener('abort', abort, { once: true })
    if (requestSignal?.aborted) abort()
    attempt.task = this.control.start(async controller => {
      attempt.controller = controller
      if (attempt.cancelled || this.disposed) controller.abort()
      const signal = AbortSignal.any([controller.signal, this.client.signal])
      try {
        signal.throwIfAborted()
        const result = await runQrLogin(this.ctx, this.client, this.credentials, signal, {
          generated: async (url, expiresAt) => {
            const image = await renderQrcode(url, Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000)))
            signal.throwIfAborted()
            this.progress = { state: 'waiting', id, image: 'data:image/png;base64,' + image.toString('base64'), expiresAt,
              message: '使用手机 B站 App 扫码，并在手机上确认登录。' }
            ready()
          },
          scanned: async () => { this.progress = { ...this.progress, state: 'scanned', message: '已扫码，请在手机 B站 App 上确认登录。' } },
        })
        signal.throwIfAborted()
        if (result.state === 'success') this.checked = {
          cookie: (await this.credentials.get()).cookie, at: Date.now(), loggedIn: result.loggedIn ?? null,
        }
        signal.throwIfAborted()
        this.progress = { state: result.state, id, message: result.state === 'expired' ? '二维码已失效，请重新获取。' : result.message }
      } catch (error) {
        this.progress = signal.aborted
          ? { state: 'cancelled', id, message: '扫码已取消。' }
          : { state: 'error', id, message: '获取或验证二维码失败，请稍后重试。' }
        if (!signal.aborted) this.ctx.logger('blipreview').warn('WebUI B站扫码失败：%s', errorSummary(error))
      } finally { ready() }
    })
    try {
      await attempt.ready
      // A generation failure may signal ready before the shared control releases its lock.
      if (!pending(this.progress.state)) await attempt.task
    } finally { requestSignal?.removeEventListener('abort', abort) }
    return this.snapshot()
  }

  async cancel(id: string) {
    const attempt = this.attempt
    // A stale tab must not cancel another tab's new QR or a login started from chat.
    if (attempt?.id === id && pending(this.progress.state)) {
      attempt.cancelled = true
      attempt.controller?.abort()
      await attempt.task
    }
    return this.snapshot()
  }

  async logout() {
    await this.control.cancel()
    await this.credentials.save('', '', this.client.signal)
    this.progress = { state: 'idle', message: '已清除本插件保存的 B站登录。' }
    this.checked = { cookie: '', at: Date.now(), loggedIn: false }
    return this.snapshot(false)
  }

  async dispose() {
    this.disposed = true
    if (this.attempt) await this.cancel(this.attempt.id)
  }

  /** Authenticated maintenance endpoint; the configuration UI does not expose a force-refresh control. */
  private async refresh(force: boolean) {
    if (!this.refresher) throw new LoginRequestError('续期服务暂不可用。', 503)
    if (this.control.running) throw new LoginRequestError('请先完成或取消当前扫码登录。', 409)
    const before = await this.credentials.get()
    await this.refresher.check(force)
    const after = await this.credentials.snapshot()
    let loggedIn: boolean | null = null
    if (after.cookie) {
      try { loggedIn = await this.client.checkLogin() } catch { /* Report an unverified login separately. */ }
    }
    return {
      hasCredentials: !!after.cookie, hasRefreshToken: !!after.refreshToken, loggedIn,
      cookieChanged: before.cookie !== after.cookie, refreshTokenChanged: before.refreshToken !== after.refreshToken,
      pendingConfirmation: !!after.refresh?.pendingToken, nextCheckAt: after.refresh?.nextCheckAt ?? null,
    }
  }

  async fetch(request: Request): Promise<Response> {
    const respond = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
    const action = new URL(request.url).pathname.slice(webLoginPath(this.config.account).length)
    try {
      if (this.disposed || this.client.signal.aborted) throw new LoginRequestError('插件已停止，请重新启用。', 503)
      if (action === '/status' && request.method === 'GET') return respond({ success: true, data: await this.status() })
      if (action === '/credentials') {
        if (request.method !== 'GET') return respond({ success: false, message: '请使用 GET' }, 405)
        return respond({ success: true, data: await this.credentials.get() })
      }
      if (action === '/refresh') {
        if (request.method !== 'POST') return respond({ success: false, message: '请使用 POST' }, 405)
        const body = await request.json().catch(() => null)
        if (!body || typeof body.force !== 'boolean') throw new LoginRequestError('请明确指定是否强制续期')
        return respond({ success: true, data: await this.refresh(body.force) })
      }
      if (!['/start', '/cancel', '/logout'].includes(action)) return respond({ success: false, message: '接口不存在' }, 404)
      if (request.method !== 'POST') return respond({ success: false, message: '请使用 POST' }, 405)
      if (action === '/logout') return respond({ success: true, data: await this.logout() })
      const body = await request.json().catch(() => null)
      if (!body || typeof body.id !== 'string') throw new LoginRequestError('缺少扫码请求 ID')
      const data = action === '/start' ? await this.start(body.id, request.signal) : await this.cancel(body.id)
      return respond({ success: true, data })
    } catch (error) {
      if (error instanceof LoginRequestError) return respond({ success: false, message: error.message }, error.status)
      this.ctx.logger('blipreview').warn('WebUI B站登录操作失败：%s', errorSummary(error))
      return respond({ success: false, message: 'B站登录操作失败，请稍后重试。' }, 500)
    }
  }
}

// Entries sharing a login profile also share one URL. Transfer its mount when the serving entry unloads.
interface Mount { server: WebUIServer; login: WebLogin }
const routes = new Map<string, { entries: Mount[]; dispose: () => void }>()

export function registerWebLogin(ctx: Context, client: BiliClient, credentials: CredentialStore, config: Config, control: LoginControl, refresher: CookieRefresher): void {
  const directory = ctx.storage.dir()
  ctx.inject(['webuiServer'], async scope => {
    let disposed = false
    scope.effect(() => () => { disposed = true })
    const key = (await directory) + '/' + config.account
    if (disposed) return
    const login = new WebLogin(scope, client, credentials, config, control, refresher)
    const entry: Mount = { server: scope.webuiServer, login }
    const prefix = webLoginPath(config.account)
    let group = routes.get(key)
    if (!group) {
      group = { entries: [], dispose: entry.server.route(prefix, { fetch: request => login.fetch(request) }) }
      routes.set(key, group)
    }
    group.entries.push(entry)
    scope.effect(() => async () => {
      const first = group.entries[0] === entry
      group.entries = group.entries.filter(other => other !== entry)
      if (first) {
        group.dispose()
        const next = group.entries[0]
        if (next) group.dispose = next.server.route(prefix, { fetch: request => next.login.fetch(request) })
      }
      if (!group.entries.length) routes.delete(key)
      await login.dispose()
    })
  })
}
