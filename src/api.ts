import type { Http, HttpRequestConfig, HttpResponse } from '@luckylillia/plugin-sdk'
import type { CredentialStore } from './credentials.js'
import { extractReference, normalizeUrl, stripSearchTitle, type VideoReference } from './parser.js'
import { WbiSigner, type WbiImages } from './wbi.js'

const REQUEST_TIMEOUT = 30_000

export const BILI_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
  Referer: 'https://www.bilibili.com/',
  Origin: 'https://www.bilibili.com',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
}

export interface VideoInfo {
  bvid: string
  aid: number
  cid: number
  title: string
  desc: string
  coverUrl: string
  uploadTime: string
  duration: string
  view: number
  danmu: number
  like: number
  coin: number
  share: number
  favorite: number
  owner: string
  ownerId: number
}

export interface VideoSearchCandidate {
  bvid: string
  aid: string
  title: string
  pic: string
}

export interface Envelope<T> { code: number; message?: string; data?: T }
interface Nav { isLogin?: boolean; wbi_img?: WbiImages }

export class BiliApiError extends Error {
  constructor(readonly code: number) {
    super('B站接口返回错误 ' + code)
    this.name = 'BiliApiError'
  }
}

/** Avoid logging HttpError.response/config: either can contain cookies or login URLs. */
export function errorSummary(error: unknown): string {
  if (error instanceof BiliApiError) return error.message
  const value = error as { name?: string; code?: string; response?: { status?: number }; cause?: { code?: string } } | undefined
  if (value?.response?.status) return 'HTTP ' + value.response.status
  const code = value?.code ?? value?.cause?.code
  if (code && /^[A-Z][A-Z0-9_]+$/.test(code)) return code
  return value?.name === 'AbortError' ? '操作已取消' : '请求或数据处理失败'
}

export function formatDuration(seconds: number): string {
  const duration = Math.max(0, Math.floor(seconds || 0))
  const parts = [Math.floor(duration / 60), duration % 60]
  return parts[0] + ':' + String(parts[1]).padStart(2, '0')
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  // B站's publication times are displayed consistently even when the Bot runs in another timezone.
  return new Date(seconds * 1000 + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ').replaceAll('-', '/')
}

const subdomainOf = (host: string, domain: string): boolean => host === domain || host.endsWith('.' + domain)

export function isBiliUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && subdomainOf(url.hostname, 'bilibili.com')
  } catch { return false }
}

export function isImageUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && ['hdslb.com', 'biliimg.com', 'bilivideo.com', 'qpic.cn', 'qlogo.cn', 'qq.com', 'qq.com.cn', 'gtimg.cn', 'gtimg.com', 'idqqimg.com']
        .some(domain => subdomainOf(url.hostname, domain))
  } catch { return false }
}

export class BiliClient {
  readonly publicHttp: Http
  readonly wbi: WbiSigner

  constructor(
    http: Http,
    private readonly credentials: CredentialStore,
    readonly signal: AbortSignal,
  ) {
    this.publicHttp = http.extend({ headers: BILI_HEADERS, timeout: REQUEST_TIMEOUT })
    this.wbi = new WbiSigner(async () => (await this.nav()).wbi_img)
  }

  private async request<T>(path: string, params: HttpRequestConfig['params'] = {}, allowedCodes: number[] = []): Promise<Envelope<T>> {
    const url = 'https://api.bilibili.com' + path
    if (!isBiliUrl(url)) throw new Error('无效的 B站接口地址')
    const { cookie } = await this.credentials.get()
    const body = await this.publicHttp.get<Envelope<T>>(url, {
      params, signal: this.signal, redirect: 'error', responseType: 'json',
      headers: cookie ? { Cookie: cookie } : {},
    })
    if (body?.code !== 0 && !allowedCodes.includes(body?.code)) throw new BiliApiError(body?.code ?? -1)
    if (body.data && typeof body.data === 'object' && 'v_voucher' in body.data && body.data.v_voucher) throw new BiliApiError(-352)
    return body
  }

  private async nav(): Promise<Nav> {
    const body = await this.request<Nav>('/x/web-interface/nav', {}, [-101])
    const data = body.data ?? {}
    this.wbi.seed(data.wbi_img)
    return { ...data, isLogin: body.code === 0 && data.isLogin === true }
  }

  async checkLogin(): Promise<boolean> { return (await this.nav()).isLogin === true }

  /** QR endpoints always start a new login and must not inherit the existing account's cookies. */
  loginRequest<T>(path: 'generate' | 'poll', params: HttpRequestConfig['params'] = {}, signal = this.signal): Promise<HttpResponse<Envelope<T>>> {
    return this.publicHttp.request('GET', 'https://passport.bilibili.com/x/passport-login/web/qrcode/' + path, {
      params, signal: AbortSignal.any([this.signal, signal]), redirect: 'error', responseType: 'json',
    })
  }

  async resolveShort(code: string): Promise<string> {
    if (!/^[a-z0-9]+$/i.test(code)) throw new Error('无效的 b23 短链')
    let url = 'https://b23.tv/' + code
    for (let redirects = 0; redirects < 5; redirects++) {
      const response = await this.publicHttp.fetch(url, { redirect: 'manual', signal: this.signal })
      await response.body?.cancel()
      if (![301, 302, 303, 307, 308].includes(response.status)) {
        if (!response.ok) throw new Error('b23 短链请求失败')
        return url
      }
      const location = response.headers.get('location')
      if (!location) throw new Error('b23 短链没有返回跳转地址')
      const target = new URL(location, url)
      if (target.protocol !== 'https:' || target.username || target.password || target.port
        || !(target.hostname === 'b23.tv' || subdomainOf(target.hostname, 'bilibili.com'))) {
        throw new Error('b23 短链指向了非 B站地址')
      }
      url = target.href
      // The video id is enough; no need to download the entire video webpage.
      if (target.hostname !== 'b23.tv' && extractReference(url)) return url
    }
    throw new Error('b23 短链跳转次数过多')
  }

  async resolve(reference: VideoReference): Promise<VideoInfo | null> {
    if ('short' in reference) {
      const resolved = extractReference(await this.resolveShort(reference.short))
      if (!resolved || 'short' in resolved) return null
      return this.video(resolved)
    }
    return this.video(reference)
  }

  async video(reference: { bvid: string } | { aid: string }): Promise<VideoInfo | null> {
    const body = await this.request<Record<string, any>>('/x/web-interface/view', reference, [-404, 62002, 62004, 62012])
    const data = body.data
    if (body.code !== 0 || !data || typeof data.title !== 'string' || !data.aid || !data.cid) return null
    const stat = data.stat ?? {}
    return {
      bvid: String(data.bvid ?? ''), aid: Number(data.aid), cid: Number(data.cid),
      title: data.title, desc: typeof data.desc === 'string' ? data.desc : '',
      coverUrl: normalizeUrl(String(data.pic ?? '')), uploadTime: formatTime(Number(data.pubdate)),
      duration: formatDuration(Number(data.duration)), view: Number(stat.view) || 0, danmu: Number(stat.danmaku) || 0,
      like: Number(stat.like) || 0, coin: Number(stat.coin) || 0, share: Number(stat.share) || 0,
      favorite: Number(stat.favorite) || 0, owner: String(data.owner?.name ?? ''), ownerId: Number(data.owner?.mid) || 0,
    }
  }

  async search(title: string): Promise<VideoSearchCandidate[]> {
    if (!title.trim()) return []
    const params = await this.wbi.sign({ search_type: 'video', keyword: title.trim() })
    const body = await this.request<{ result?: Record<string, any>[] }>('/x/web-interface/wbi/search/type', params)
    if (!Array.isArray(body.data?.result)) return []
    return body.data.result.filter(item => item.type === 'video' && (item.bvid || item.aid || item.id)).slice(0, 20).map(item => ({
      bvid: String(item.bvid ?? ''), aid: String(item.aid ?? item.id ?? ''),
      title: stripSearchTitle(String(item.title ?? '')), pic: normalizeUrl(String(item.pic ?? '')),
    }))
  }

  async subtitle(info: VideoInfo, maxLength: number): Promise<string> {
    const params = await this.wbi.sign({ aid: info.aid, cid: info.cid })
    const body = await this.request<{ subtitle?: { subtitles?: { lan?: string; subtitle_url?: string }[] } }>('/x/player/wbi/v2', params)
    const subtitles = body.data?.subtitle?.subtitles ?? []
    const priorities = ['zh-Hans', 'zh-CN', 'zh', 'ai-zh']
    const chosen = priorities.map(lan => subtitles.find(item => item.lan === lan)).find(Boolean) ?? subtitles[0]
    const url = normalizeUrl(chosen?.subtitle_url ?? '')
    if (!url || !isImageUrl(url)) return ''
    // Subtitle CDN requests, like images, use the cookie-free client.
    const subtitle = await this.publicHttp.get<{ body?: { content?: string }[] }>(url, { signal: this.signal, responseType: 'json' })
    if (!Array.isArray(subtitle.body)) return ''
    return subtitle.body.map(line => typeof line.content === 'string' ? line.content : '').filter(Boolean).join('\n').slice(0, maxLength)
  }

  async officialSummary(info: VideoInfo): Promise<string> {
    const params = await this.wbi.sign({ aid: info.aid, cid: info.cid, bvid: info.bvid, up_mid: info.ownerId })
    const body = await this.request<{ model_result?: { summary?: string } }>('/x/web-interface/view/conclusion/get', params)
    return typeof body.data?.model_result?.summary === 'string' ? body.data.model_result.summary.trim() : ''
  }

  async image(url: string): Promise<Buffer> {
    if (!isImageUrl(url)) throw new Error('图片地址不是 B站或 QQ 的图片服务')
    const file = await this.publicHttp.file(url, { signal: this.signal })
    if (!file.type.startsWith('image/') || file.data.byteLength > 10 * 1024 * 1024) throw new Error('图片格式或大小不受支持')
    return Buffer.from(file.data)
  }
}
