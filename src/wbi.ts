import { createHash } from 'node:crypto'

const MIXIN = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
]

export interface WbiImages { img_url?: string; sub_url?: string }
export type WbiParams = Record<string, string | number>

export function signWbi(params: WbiParams, imgKey: string, subKey: string, timestamp = Math.floor(Date.now() / 1000)): Record<string, string> {
  const original = imgKey + subKey
  if (original.length !== 64) throw new Error('B站 WBI 签名密钥无效')
  const mixin = MIXIN.map(index => original[index]).join('').slice(0, 32)
  const merged = { ...params, wts: timestamp }
  const values: Record<string, string> = {}
  for (const key of Object.keys(merged).sort()) values[key] = String(merged[key as keyof typeof merged]).replace(/[!'()*]/g, '')
  // WBI uses encodeURIComponent, including %20 for spaces (URLSearchParams uses +).
  const query = Object.entries(values).map(([key, value]) => encodeURIComponent(key) + '=' + encodeURIComponent(value)).join('&')
  values.w_rid = createHash('md5').update(query + mixin).digest('hex')
  return values
}

export class WbiSigner {
  private keys?: { img: string; sub: string; expires: number }
  private pending?: Promise<void>

  constructor(private readonly fetchImages: () => Promise<WbiImages | undefined>) {}

  seed(images?: WbiImages): void {
    const key = (url?: string) => url?.split('/').pop()?.split('.')[0] ?? ''
    const img = key(images?.img_url)
    const sub = key(images?.sub_url)
    if (/^[a-f0-9]{32}$/i.test(img) && /^[a-f0-9]{32}$/i.test(sub)) {
      this.keys = { img, sub, expires: Date.now() + 6 * 60 * 60 * 1000 }
    }
  }

  async sign(params: WbiParams): Promise<Record<string, string>> {
    if (!this.keys || this.keys.expires <= Date.now()) {
      this.pending ??= this.fetchImages().then(images => this.seed(images)).finally(() => { this.pending = undefined })
      await this.pending
    }
    if (!this.keys || this.keys.expires <= Date.now()) throw new Error('未能获取 B站 WBI 签名密钥')
    return signWbi(params, this.keys.img, this.keys.sub)
  }
}
