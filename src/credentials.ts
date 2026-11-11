import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PluginStorage } from '@luckylillia/plugin-sdk'

export interface Credentials {
  cookie: string
  refreshToken: string
}

export interface RefreshState {
  nextCheckAt: number
  /** Confirm with the new Cookie and this old token, after the new login is on disk. */
  pendingToken?: string
}

export interface CredentialSnapshot extends Credentials {
  revision: string
  refresh?: RefreshState
}

interface SavedCredentials extends Credentials {
  version: 1
  configHash: string
  revision?: string
  refresh?: RefreshState
}

// Plugin entries may share an account. Serialize their read/modify/write operations together.
const operations = new Map<string, Promise<void>>()
function serial<T>(key: string, work: () => Promise<T>): Promise<T> {
  const task = (operations.get(key) ?? Promise.resolve()).then(work)
  const done = task.then(() => {}, () => {})
  operations.set(key, done)
  void done.then(() => { if (operations.get(key) === done) operations.delete(key) })
  return task
}

export function normalizeCookie(raw: string): string {
  const cookie = raw.replace(/^\s*cookie:\s*/i, '').replace(/\r?\n/g, ' ').trim()
  if (/[\x00-\x1f\x7f]/.test(cookie)) throw new Error('Cookie 中含有无效的控制字符')
  return cookie.split(';').map(pair => pair.trim()).filter(Boolean).join('; ')
}

export function cookieValue(cookie: string, key: string): string {
  for (const pair of cookie.split(';')) {
    const eq = pair.indexOf('=')
    if (eq > 0 && pair.slice(0, eq).trim() === key) return pair.slice(eq + 1).trim()
  }
  return ''
}

export const LOGIN_COOKIE_KEYS = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid']

/** Keep percent-encoded values intact and never copy Set-Cookie attributes into Cookie. */
export function loginCookieHeaders(headers: Headers): Map<string, string> {
  const cookies = new Map<string, string>()
  for (const line of headers.getSetCookie()) {
    const pair = line.split(';', 1)[0]
    const eq = pair.indexOf('=')
    const key = pair.slice(0, eq).trim()
    if (eq > 0 && LOGIN_COOKIE_KEYS.includes(key)) cookies.set(key, pair.slice(eq + 1).trim())
  }
  return cookies
}

/** Runtime login data belongs to ctx.storage, never the host's plugins.json. */
export class CredentialStore {
  readonly ready: Promise<void>
  readonly key: Promise<string>
  private readonly configHash: string
  private writes: Promise<void> = Promise.resolve()

  constructor(storage: PluginStorage, account: string, initial: { cookie: string | null; refreshToken: string | null; loginRevision?: string }) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(account)) throw new Error('无效的 B站登录档案名')
    const loginRevision = initial.loginRevision
    const normalized = { cookie: normalizeCookie(initial.cookie ?? ''), refreshToken: initial.refreshToken?.trim() ?? '' }
    // Keep the old hash for untouched configs so upgrading preserves existing QR logins.
    this.configHash = createHash('sha256').update(JSON.stringify(loginRevision ? { ...normalized, loginRevision } : normalized)).digest('hex')
    // Capture this plugin's storage in apply(), before another plugin can be the service caller.
    this.key = storage.dir().then(async root => {
      const dir = join(root, 'accounts')
      await mkdir(dir, { recursive: true })
      return join(dir, account + '.json')
    })
    this.ready = this.initialize(normalized)
  }

  private async read(): Promise<SavedCredentials | undefined> {
    let text: string
    try {
      text = await readFile(await this.key, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    try {
      const data: SavedCredentials = JSON.parse(text)
      if (data.version === 1 && typeof data.cookie === 'string'
        && typeof data.refreshToken === 'string' && typeof data.configHash === 'string'
        && (data.revision === undefined || typeof data.revision === 'string')
        && (data.refresh === undefined || (data.refresh && Number.isFinite(data.refresh.nextCheckAt)
          && (data.refresh.pendingToken === undefined || typeof data.refresh.pendingToken === 'string')))) return data
    } catch { /* Do not include JSON parse errors: they can quote credentials. */ }
    throw new Error('B站登录档案格式损坏，请检查插件数据目录中的 accounts 文件')
  }

  private snapshotOf(saved?: SavedCredentials): CredentialSnapshot {
    return {
      cookie: saved?.cookie ?? '', refreshToken: saved?.refreshToken ?? '',
      // Old version-1 files are read without rewriting their credentials on upgrade.
      revision: saved?.revision ?? createHash('sha256').update(JSON.stringify(saved ?? null)).digest('hex'),
      ...(saved?.refresh ? { refresh: saved.refresh } : {}),
    }
  }

  private async write(credentials: Credentials & { refresh?: RefreshState }, configHash = this.configHash, signal?: AbortSignal): Promise<CredentialSnapshot> {
    const filename = await this.key
    const temporary = filename + '.' + randomUUID() + '.tmp'
    const record: SavedCredentials = { version: 1, configHash, ...credentials, revision: randomUUID() }
    try {
      signal?.throwIfAborted()
      await writeFile(temporary, JSON.stringify(record) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      signal?.throwIfAborted()
      await rename(temporary, filename)
      return this.snapshotOf(record)
    } finally {
      await unlink(temporary).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      })
    }
  }

  private async initialize(initial: Credentials): Promise<void> {
    await serial(await this.key, async () => {
      const saved = await this.read()
      // A changed form imports a new login. Unchanged defaults must not erase a QR/command login on reload.
      if (!saved || saved.configHash !== this.configHash) await this.write(initial)
    })
  }

  async get(): Promise<Credentials> {
    const { cookie, refreshToken } = await this.snapshot()
    return { cookie, refreshToken }
  }

  async snapshot(): Promise<CredentialSnapshot> {
    await this.ready
    await this.writes
    // Named profiles can be deliberately shared by multiple plugin entries.
    return serial(await this.key, async () => this.snapshotOf(await this.read()))
  }

  async settled(): Promise<void> {
    await this.ready.catch(() => {})
    await this.writes
  }

  private update<T>(work: () => Promise<T>): Promise<T> {
    const task = this.writes.then(async () => {
      await this.ready
      return serial(await this.key, work)
    })
    this.writes = task.then(() => {}, () => {})
    return task
  }

  save(cookie: string, refreshToken = '', signal?: AbortSignal): Promise<void> {
    const normalized = normalizeCookie(cookie)
    const credentials = { cookie: normalized, refreshToken: normalized ? refreshToken.trim() : '' }
    return this.update(async () => { await this.write(credentials, (await this.read())?.configHash, signal) })
  }

  /** A late refresh must never overwrite a logout, another login, or newer form settings. */
  replace(expected: CredentialSnapshot, next: Credentials & { refresh?: RefreshState }, signal?: AbortSignal): Promise<CredentialSnapshot | undefined> {
    return this.update(async () => {
      signal?.throwIfAborted()
      const saved = await this.read()
      if (this.snapshotOf(saved).revision !== expected.revision) return
      return this.write({ cookie: normalizeCookie(next.cookie), refreshToken: next.refreshToken.trim(),
        ...(next.refresh ? { refresh: next.refresh } : {}) }, saved?.configHash, signal)
    })
  }
}
