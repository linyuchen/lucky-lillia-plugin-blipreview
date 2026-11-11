import { constants, createPublicKey, publicEncrypt } from 'node:crypto'
import type { Context, HttpResponse } from '@luckylillia/plugin-sdk'
import { BiliApiError, errorSummary, type BiliClient, type Envelope } from './api.js'
import { cookieValue, loginCookieHeaders, normalizeCookie, type CredentialSnapshot, type CredentialStore } from './credentials.js'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const PASSPORT = 'https://passport.bilibili.com/x/passport-login/web/'
// The public RSA key used by B站's Web Cookie refresh protocol (RSA-OAEP / SHA-256).
const PUBLIC_KEY = createPublicKey({ format: 'jwk', key: {
  kty: 'RSA', e: 'AQAB',
  n: 'y4HdjgJHBlbaBN04VERG4qNBIFHP6a3GozCl75AihQloSWCXC5HDNgyinEnhaQ_4-gaMud_GF50elYXLlCToR9se9Z8z433U3KjM-3Yx7ptKkmQNAMggQwAVKgq3zYAoidNEWuxpkY_mAitTSRLnsJW-NCTa0bqBFF6Wm1MxgfE',
} })

interface CookieInfo { refresh: boolean; timestamp: number }
interface Refreshed { status: number; refresh_token: string }

export function correspondPath(timestamp: number): string {
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) throw new Error('B站续期时间戳无效')
  return publicEncrypt({ key: PUBLIC_KEY, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from('refresh_' + timestamp)).toString('hex')
}

function refreshedCookie(original: string, headers: Headers): string {
  const received = loginCookieHeaders(headers)
  if (!received.get('SESSDATA') || !received.get('bili_jct')) throw new Error('B站续期未返回完整 Cookie')
  const oldUid = cookieValue(original, 'DedeUserID')
  if (oldUid && received.get('DedeUserID') && received.get('DedeUserID') !== oldUid) throw new Error('B站续期账号不匹配')
  const merged = new Map<string, string>()
  for (const pair of original.split(';')) {
    const eq = pair.indexOf('=')
    if (eq > 0) merged.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
  }
  for (const [key, value] of received) {
    if (value) merged.set(key, value)
    else merged.delete(key)
  }
  return normalizeCookie([...merged].map(([key, value]) => key + '=' + value).join('; '))
}

// One refresh exchange per account, even if several enabled entries share its credentials.
interface RefreshTask { force: boolean; promise: Promise<void> }
const refreshing = new Map<string, RefreshTask>()

export class CookieRefresher {
  private task?: RefreshTask
  private readonly logger

  constructor(ctx: Context, private readonly client: BiliClient, private readonly credentials: CredentialStore) {
    this.logger = ctx.logger('blipreview')
  }

  /** Force is only for an explicit maintenance request; automatic scheduling always checks B站 first. */
  check(force = false): Promise<void> {
    if (this.task) {
      const active = this.task
      return force && !active.force ? active.promise.then(() => this.check(true)) : active.promise
    }
    const promise = this.checkShared(force).catch(error => {
      if (!this.client.signal.aborted) this.logger.warn('检查 B站自动续期失败：%s', errorSummary(error))
    }).finally(() => { if (this.task?.promise === promise) this.task = undefined })
    this.task = { force, promise }
    return promise
  }

  async settled(): Promise<void> { await this.task?.promise }

  private async checkShared(force: boolean): Promise<void> {
    await this.credentials.ready
    this.client.signal.throwIfAborted()
    const key = await this.credentials.key
    const active = refreshing.get(key)
    if (active) {
      await active.promise
      if (force && !active.force) await this.checkShared(true)
      return
    }
    const promise = this.refresh(force).finally(() => { if (refreshing.get(key)?.promise === promise) refreshing.delete(key) })
    refreshing.set(key, { force, promise })
    await promise
  }

  private async current(snapshot: CredentialSnapshot): Promise<boolean> {
    this.client.signal.throwIfAborted()
    return (await this.credentials.snapshot()).revision === snapshot.revision
  }

  private async request<T>(path: 'cookie/info' | 'cookie/refresh' | 'confirm/refresh', cookie: string, form?: Record<string, string>): Promise<HttpResponse<Envelope<T>>> {
    this.client.signal.throwIfAborted()
    const response = await this.client.publicHttp.request<Envelope<T>>(form ? 'POST' : 'GET', PASSPORT + path, {
      headers: { Cookie: cookie, ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      ...(form ? { data: new URLSearchParams(form) } : { params: { csrf: cookieValue(cookie, 'bili_jct') } }),
      responseType: 'json', signal: this.client.signal, redirect: 'error',
    })
    this.client.signal.throwIfAborted()
    if (response.data?.code !== 0) throw new BiliApiError(Number.isInteger(response.data?.code) ? response.data.code : -1)
    return response
  }

  private async info(cookie: string): Promise<CookieInfo> {
    const { data } = (await this.request<CookieInfo>('cookie/info', cookie)).data
    if (!data || typeof data.refresh !== 'boolean') throw new Error('B站续期检查响应无效')
    return data
  }

  private async confirm(snapshot: CredentialSnapshot): Promise<void> {
    if (!await this.current(snapshot)) return
    try {
      await this.request('confirm/refresh', snapshot.cookie, {
        csrf: cookieValue(snapshot.cookie, 'bili_jct'), refresh_token: snapshot.refresh!.pendingToken!,
      })
    } catch (error) {
      // A confirmation can reach B站 even when its response is lost. Do not retry an invalid old
      // token forever: on a repeated -400, verify the new login before resuming daily checks.
      if (!(error instanceof BiliApiError && error.code === -400 && snapshot.refresh!.nextCheckAt > 0)) throw error
      await this.info(snapshot.cookie)
      this.logger.warn('B站续期确认返回无效请求；新登录仍有效，将继续定时检查')
    }
    const saved = await this.credentials.replace(snapshot, {
      ...snapshot, refresh: { nextCheckAt: Date.now() + DAY },
    }, this.client.signal)
    if (saved) this.logger.info('B站登录已自动续期，新凭据已保存')
  }

  private async refresh(force: boolean): Promise<void> {
    let snapshot = await this.credentials.snapshot()
    if (!snapshot.cookie || !snapshot.refreshToken || !cookieValue(snapshot.cookie, 'SESSDATA') || !cookieValue(snapshot.cookie, 'bili_jct')) return
    const next = snapshot.refresh?.nextCheckAt ?? 0
    // A bad clock or corrupt future timestamp must not disable renewal indefinitely.
    if (!force && next > Date.now() && next <= Date.now() + DAY) return
    try {
      if (snapshot.refresh?.pendingToken) return await this.confirm(snapshot)
      const info = await this.info(snapshot.cookie)
      if (!await this.current(snapshot)) return
      if (!info.refresh && !force) {
        await this.credentials.replace(snapshot, { ...snapshot, refresh: { nextCheckAt: Date.now() + DAY } }, this.client.signal)
        return
      }

      // Use the server's clock. Read the HTML token without running its scripts or loading its assets.
      const html = await this.client.publicHttp.get<string>('https://www.bilibili.com/correspond/1/' + correspondPath(info.timestamp), {
        headers: { Cookie: snapshot.cookie }, responseType: 'text', signal: this.client.signal, redirect: 'error',
      })
      const csrf = typeof html === 'string' ? html.match(/<div\b[^>]*\bid\s*=\s*["']1-name["'][^>]*>\s*([a-zA-Z0-9_-]{16,256})\s*<\/div\s*>/i)?.[1] : undefined
      if (!csrf) throw new Error('B站续期页面未返回 refresh_csrf')
      if (!await this.current(snapshot)) return
      const response = await this.request<Refreshed>('cookie/refresh', snapshot.cookie, {
        csrf: cookieValue(snapshot.cookie, 'bili_jct'), refresh_csrf: csrf, source: 'main_web', refresh_token: snapshot.refreshToken,
      })
      const data = response.data.data
      if (!data || data.status !== 0 || typeof data.refresh_token !== 'string' || !data.refresh_token.trim()) throw new Error('B站续期响应无效')
      const cookie = refreshedCookie(snapshot.cookie, response.headers)
      // Save before invalidating the old login. Remember the old token so confirmation can resume
      // after a network failure or restart. A manual logout/login wins over this exchange.
      const saved = await this.credentials.replace(snapshot, {
        cookie, refreshToken: data.refresh_token.trim(), refresh: { nextCheckAt: 0, pendingToken: snapshot.refreshToken },
      }, this.client.signal)
      if (!saved) return
      snapshot = saved
      await this.confirm(snapshot)
    } catch (error) {
      if (this.client.signal.aborted) return
      const invalid = error instanceof BiliApiError && [-101, -111, 86095].includes(error.code)
      const saved = await this.credentials.replace(snapshot, {
        ...snapshot, refresh: { ...snapshot.refresh, nextCheckAt: Date.now() + (invalid ? DAY : HOUR) },
      }, this.client.signal)
      if (!saved) return
      if (invalid) this.logger.warn('B站登录凭据已失效或不匹配，无法自动续期，请重新扫码登录（%s）', errorSummary(error))
      else this.logger.warn(snapshot.refresh?.pendingToken
        ? 'B站新登录已保存，续期确认失败，将在一小时后重试：%s'
        : 'B站自动续期失败，保留现有登录，将在一小时后重试：%s', errorSummary(error))
    }
  }
}

export function registerAutoRefresh(ctx: Context, client: BiliClient, credentials: CredentialStore): CookieRefresher {
  const refresher = new CookieRefresher(ctx, client, credentials)
  // The hourly tick picks up new QR/manual logins; unchanged accounts query B站 at most daily.
  ctx.interval(() => { void refresher.check() }, HOUR)
  return refresher
}
