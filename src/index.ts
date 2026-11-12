import { h, type Context, type Session } from '@luckylillia/plugin-sdk'
import type { AiService } from './ai.js'
import { BiliClient, errorSummary, type VideoInfo, type VideoSearchCandidate } from './api.js'
import { Config } from './config.js'
import { CredentialStore } from './credentials.js'
import { registerLogin } from './login.js'
import { registerWebLogin } from './web-login.js'
import { registerAutoRefresh } from './refresh.js'
import { extractReference, messageInput, pickExactTitleCandidates, type BiliCard, type VideoReference } from './parser.js'
import { formatMarkdown, formatText, matchCover, pageUrl, renderCard, renderCover } from './render.js'
import { buildSummary } from './summary.js'
import { uploadQQImage } from './qq-media.js'

export { Config }
export const name = 'blipreview'
export const inject = ['bots', 'commands', 'http', 'timer']

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger(name)
  const controller = new AbortController()
  const credentials = new CredentialStore(ctx.storage, config.account, config)
  const client = new BiliClient(ctx.http, credentials, controller.signal)
  const refresher = registerAutoRefresh(ctx, client, credentials)
  const cache = new Map<string, number>()
  const sending = new Set<string>()
  const resolving = new Map<string, Promise<VideoInfo | null>>()
  ctx.effect(() => async () => {
    controller.abort()
    cache.clear()
    sending.clear()
    resolving.clear()
    await refresher.settled()
    await credentials.settled()
  })
  credentials.ready.catch(error => logger.warn('读取 B站登录档案失败：%s', errorSummary(error)))

  let ai: AiService | undefined
  ctx.inject(['ai'], scope => {
    const provider = scope.get('ai') as AiService
    ai = provider
    scope.effect(() => () => { if (ai === provider) ai = undefined })
  })

  void (async () => {
    try {
      await refresher.check()
      if ((await credentials.get()).cookie && !await client.checkLogin()) logger.warn('B站登录已失效，请使用「登录B站」重新扫码')
    } catch (error) {
      if (!controller.signal.aborted) logger.warn('检查 B站登录状态失败：%s', errorSummary(error))
    }
  })()

  async function chooseCandidate(card: BiliCard, candidates: VideoSearchCandidate[]): Promise<VideoSearchCandidate> {
    if (candidates.length < 2 || !card.preview) return candidates[0]
    try {
      const preview = await client.image(card.preview)
      const covers: { index: number; data: Buffer }[] = []
      for (let offset = 0; offset < candidates.length; offset += 4) {
        const batch = await Promise.allSettled(candidates.slice(offset, offset + 4).map(async (candidate, index) => ({
          index: offset + index, data: await client.image(candidate.pic),
        })))
        for (const result of batch) {
          if (result.status === 'fulfilled') covers.push(result.value)
          else logger.debug('下载候选封面失败：%s', errorSummary(result.reason))
        }
        controller.signal.throwIfAborted()
      }
      const index = await matchCover(preview, covers)
      if (index !== undefined) return candidates[index]
    } catch (error) {
      if (!controller.signal.aborted) logger.debug('分享卡片封面比对失败：%s', errorSummary(error))
    }
    return candidates[0]
  }

  async function resolve(reference?: VideoReference, card?: BiliCard): Promise<VideoInfo | null> {
    reference ??= card?.reference
    const key = JSON.stringify(reference ?? card)
    if (!key) return null
    let task = resolving.get(key)
    if (!task) {
      task = (async () => {
        if (reference) return client.resolve(reference)
        if (!card?.title) return null
        const exact = pickExactTitleCandidates(await client.search(card.title), card.title)
        if (!exact.length) return null
        const chosen = await chooseCandidate(card, exact)
        return client.video(chosen.bvid ? { bvid: chosen.bvid } : { aid: chosen.aid })
      })().finally(() => { resolving.delete(key) })
      resolving.set(key, task)
    }
    return task
  }

  async function sendPreview(session: Session, info: VideoInfo, summary: string): Promise<void> {
    let content: h.Fragment
    let disposeImage: (() => Promise<void>) | undefined
    const markdown = session.bot.features.includes('message.markdown')
    let cover: Buffer | undefined
    if (info.coverUrl) {
      try { cover = await client.image(info.coverUrl) }
      catch (error) { if (!controller.signal.aborted) logger.debug('下载视频封面失败：%s', errorSummary(error)) }
    }
    controller.signal.throwIfAborted()
    try {
      if (markdown) {
        const png = await renderCover(info, cover)
        let url = 'data:image/png;base64,' + png.toString('base64')
        if (session.bot.platform === 'qq') {
          const image = await uploadQQImage(ctx, session.bot, png, controller.signal)
          url = image.url
          disposeImage = image.dispose
        }
        content = h('markdown', {}, formatMarkdown(info, summary, {
          url, width: png.readUInt32BE(16), height: png.readUInt32BE(20),
        }))
      } else {
        const png = await renderCard(info, summary, cover)
        content = [h.image(png, 'image/png'), h.text('\n' + pageUrl(info))]
      }
    } catch (error) {
      logger.warn('生成或上传预览图片失败，改用基础预览：%s', errorSummary(error))
      content = markdown ? h('markdown', {}, formatMarkdown(info, summary)) : h.text(formatText(info, summary))
    }
    try {
      controller.signal.throwIfAborted()
      await session.send(content)
    } finally {
      await disposeImage?.()
    }
  }

  async function preview(session: Session, reference?: VideoReference, card?: BiliCard): Promise<void> {
    const info = await resolve(reference, card)
    if (!info) return
    const key = JSON.stringify([session.bot.sid, session.isDirect, session.channelId, info.bvid || info.aid])
    const now = Date.now()
    const ttl = config.cacheDuration * 1000
    for (const [entry, timestamp] of cache) if (now - timestamp >= ttl) cache.delete(entry)
    if (sending.has(key) || (ttl > 0 && cache.has(key))) return
    sending.add(key)
    try {
      let summary = ''
      try { summary = await buildSummary(client, info, config, ai) }
      catch (error) { if (!controller.signal.aborted) logger.warn('生成 B站视频总结失败：%s', errorSummary(error)) }
      controller.signal.throwIfAborted()
      await sendPreview(session, info, summary)
      // Failed requests/sends are retriable immediately; only successful replies enter the cooldown.
      if (ttl > 0) {
        cache.set(key, Date.now())
        if (cache.size > 5000) cache.delete(cache.keys().next().value!)
      }
    } finally { sending.delete(key) }
  }

  const login = registerLogin(ctx, client, credentials, config)
  registerWebLogin(ctx, client, credentials, config, login, refresher)

  ctx.on('bot/message', async (session, next) => {
    if (!session.channelId || session.userId === session.selfId) return next()
    const { text, card } = messageInput(session)
    const reference = extractReference(text)
    if (reference || card) {
      try { await preview(session, reference, card) }
      catch (error) { if (!controller.signal.aborted) logger.warn('自动解析 B站视频失败：%s', errorSummary(error)) }
    }
    return next()
  })
}
