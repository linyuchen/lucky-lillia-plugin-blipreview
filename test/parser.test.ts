import { describe, expect, it } from 'vitest'
import { h, type Session } from '@luckylillia/plugin-sdk'
import { extractReference, messageInput, pickExactTitleCandidates } from '../src/parser.js'
import { BVID } from './fixtures.js'

const input = (content: string, raw?: unknown) => messageInput({ elements: h.parse(content), event: { _data: raw } } as Session)

describe('video and card recognition', () => {
  it.each([
    [BVID, { bvid: BVID }], ['看 ' + BVID.toLowerCase().slice(0, 2) + BVID.slice(2) + '！', { bvid: BVID }],
    ['https://www.bilibili.com/video/' + BVID + '?p=1', { bvid: BVID }],
    ['AV1', { aid: '1' }], ['https://b23.tv/aBc123', { short: 'aBc123' }],
    ['B23.TV/aBc123', { short: 'aBc123' }],
  ])('recognizes %s', (text, reference) => expect(extractReference(text as string)).toEqual(reference))

  it.each(['BV123', BVID + 'extra', 'nav123456', 'avatar1234', 'av0', 'x' + BVID, 'https://evil.b23.tv/nope'])('ignores false positives: %s', text => {
    expect(extractReference(text)).toBeUndefined()
  })

  it.each(['ntqq:ark', 'luckylillia:ark'])('extracts an NTQQ miniapp link from %s, including older Bot versions', (type) => {
    const ark = { app: 'com.tencent.miniapp_01', desc: '哔哩哔哩', meta: { detail_1: {
      title: '哔哩哔哩', desc: '视频标题', qqdocurl: 'https://b23.tv/cardLink', preview: '//gchat.qpic.cn/preview.png',
    } } }
    expect(input(h(type, { data: JSON.stringify(ark) }).toString()).card).toEqual({
      title: '视频标题', preview: 'https://gchat.qpic.cn/preview.png', reference: { short: 'cardLink' },
    })
  })

  it('reads official raw miniapp metadata and its text fallback', () => {
    const card = { ark_type: 'miniapp', fields: { source: 'bilibili', title: '标题', preview: '//gchat.qpic.cn/p.png' } }
    expect(input('', { d: { ark_data: card } }).card).toMatchObject({ title: '标题', preview: 'https://gchat.qpic.cn/p.png' })
    expect(input('[卡片消息] 小程序\nsource: bilibili\ntitle: 标题\npreview: //gchat.qpic.cn/p.png').card).toMatchObject({ title: '标题' })
    expect(input('[卡片消息] 小程序\nsource: 其他网站\ntitle: 标题').card).toBeUndefined()
  })

  it('does not inspect quoted text or image URL attributes', () => {
    const content = h('quote', { id: 'previous' }, BVID).toString() + h.image('https://example.com/' + BVID).toString() + '好看'
    expect(input(content)).toEqual({ text: '好看', card: undefined })
    expect(input(h('a', { href: 'https://www.bilibili.com/video/' + BVID }, '链接').toString()).text).toContain(BVID)
  })

  it('requires exact normalized titles instead of a loosely related search result', () => {
    const candidates = [{ title: '完全不同的视频' }, { title: '<em class="keyword">ＡＢＣ</em>：星空 &amp; 夜景！' }]
    expect(pickExactTitleCandidates(candidates, 'ABC 星空 & 夜景')).toEqual([candidates[1]])
    expect(pickExactTitleCandidates(candidates, '星空')).toEqual([])
    expect(pickExactTitleCandidates(candidates, '⭐')).toEqual([])
  })
})
