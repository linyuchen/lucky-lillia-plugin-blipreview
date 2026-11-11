import { h, type Session } from '@luckylillia/plugin-sdk'

export type VideoReference = { bvid: string } | { aid: string } | { short: string }

export interface BiliCard {
  title: string
  preview: string
  reference?: VideoReference
}

function record(value: unknown): Record<string, any> {
  if (typeof value === 'string' && value.length <= 131072) {
    try { value = JSON.parse(value) } catch { return {} }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
}

const string = (value: unknown): string => typeof value === 'string' ? value.trim() : ''
const biliSource = (value: string): boolean => /哔哩|bilibili|b站/i.test(value)

export function normalizeUrl(raw: string): string {
  const value = raw.startsWith('//') ? 'https:' + raw : raw
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return ''
    url.protocol = 'https:'
    return url.href
  } catch { return '' }
}

export function extractReference(text: string): VideoReference | undefined {
  const matches: { index: number; ref: VideoReference }[] = []
  const bv = /(?<![a-z0-9])BV([a-z0-9]{10})(?![a-z0-9])/i.exec(text)
  if (bv) matches.push({ index: bv.index, ref: { bvid: 'BV' + bv[1] } })
  const av = /(?<![a-z0-9])av([1-9]\d{0,18})(?![a-z0-9])/i.exec(text)
  if (av) matches.push({ index: av.index, ref: { aid: av[1] } })
  const short = /(?<![\w.-])(?:https?:\/\/)?b23\.tv\/([a-z0-9]+)(?![a-z0-9])/i.exec(text)
  if (short) matches.push({ index: short.index, ref: { short: short[1] } })
  return matches.sort((a, b) => a.index - b.index)[0]?.ref
}

function fromArk(value: unknown): BiliCard | undefined {
  const ark = record(value)
  const fields = record(ark.fields)
  const meta = record(ark.meta)
  const detail = record(meta.detail_1 ?? meta.detail)
  const news = record(meta.news)
  const sources = [fields.source, ark.desc, detail.title, news.tag, record(ark.appInfo).appName].map(string).join(' ')
  const links = [fields.jump_url, fields.jumpUrl, fields.url, fields.qqdocurl,
    detail.qqdocurl, detail.url, detail.jumpUrl, news.jumpUrl, ark.url].map(string)
  const reference = links.map(extractReference).find(Boolean)
  if (!biliSource(sources) && !reference) return
  const prompt = string(ark.prompt).replace(/^\[(?:QQ小程序|分享)\]\s*/, '')
  const title = string(fields.title) || string(detail.desc) || string(news.title) || prompt
  if (!title && !reference) return
  return { title, preview: normalizeUrl(string(fields.preview) || string(detail.preview) || string(news.preview)), reference }
}

function fromText(text: string): BiliCard | undefined {
  if (!/^\[卡片消息\]\s*小程序/m.test(text)) return
  const field = (name: string) => new RegExp('^' + name + ':\\s*(.+)$', 'im').exec(text)?.[1]?.trim() ?? ''
  if (!biliSource(field('source')) || !field('title')) return
  return { title: field('title'), preview: normalizeUrl(field('preview')) }
}

/** Ignore quoted messages and media attributes; only this message's text, links and cards are triggers. */
export function messageInput(session: Session): { text: string; card?: BiliCard } {
  const texts: string[] = []
  let card: BiliCard | undefined
  const visit = (elements: h[]) => {
    for (const element of elements) {
      if (element.type === 'quote') continue
      if (element.type === 'text') texts.push(String(element.attrs.content ?? ''))
      else if (['luckylillia:ark', 'qq:ark', 'json'].includes(element.type)) {
        card ??= fromArk(element.attrs.data ?? element.attrs.content ?? element.attrs)
      } else {
        if (element.type === 'a') texts.push(string(element.attrs.href))
        if (!['img', 'audio', 'video', 'file'].includes(element.type)) visit(element.children)
      }
    }
  }
  visit(session.elements)
  const raw = record(session.event._data)
  const data = record(raw.d ?? raw)
  card ??= fromArk(data.ark_data)
  const text = texts.join('')
  card ??= fromText(text)
  return { text, card }
}

export function stripSearchTitle(raw: string): string {
  const entities: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
  return raw.replace(/<[^>]+>/g, '').replace(/&(#x[\da-f]+|#\d+|nbsp|amp|lt|gt|quot|apos);/gi, (entity, code: string) => {
    if (!code.startsWith('#')) return entities[code.toLowerCase()] ?? entity
    const number = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1))
    return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : entity
  }).trim()
}

export function normalizeTitle(title: string): string {
  return stripSearchTitle(title).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

export function pickExactTitleCandidates<T extends { title: string }>(candidates: T[], title: string): T[] {
  const target = normalizeTitle(title)
  return target ? candidates.filter(candidate => normalizeTitle(candidate.title) === target) : []
}
