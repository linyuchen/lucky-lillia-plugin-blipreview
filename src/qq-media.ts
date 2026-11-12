import { createHash } from 'node:crypto'
import type { Bot, Context } from '@luckylillia/plugin-sdk'
import { errorSummary } from './api.js'

interface QQMediaApi {
  prepareMediaImage(data: {
    file_name: string; file_size: number; content_type: string; md5: string; sha1: string
  }): Promise<{ upload_id: string; presigned_url: string }>
  completeMediaImage(data: { upload_id: string; md5: string }): Promise<{ image_id: string; url: string }>
  deleteMediaImage(imageId: string): Promise<unknown>
}

/** A temporary QQ material; sent messages retain their own copy after it is deleted. */
export async function uploadQQImage(ctx: Context, bot: Bot, png: Buffer, signal: AbortSignal): Promise<{
  url: string
  dispose: () => Promise<void>
}> {
  const api = bot.internal as Partial<QQMediaApi> | undefined
  if (!api || !['prepareMediaImage', 'completeMediaImage', 'deleteMediaImage'].every(name => typeof api[name as keyof QQMediaApi] === 'function')) {
    throw new Error('当前宿主不支持 QQ Markdown 素材接口，请更新 LuckyLillia.Bot')
  }
  if (png.length > 10 * 1024 * 1024) throw new Error('QQ Markdown 图片超过 10 MB')
  const md5 = createHash('md5').update(png).digest('hex')
  signal.throwIfAborted()
  const prepared = await api.prepareMediaImage!({
    file_name: 'blipreview-' + md5 + '.png', file_size: png.length, content_type: 'image/png',
    md5, sha1: createHash('sha1').update(png).digest('hex'),
  })
  signal.throwIfAborted()
  if (!prepared.upload_id || !/^https:\/\//i.test(prepared.presigned_url)) throw new Error('QQ 素材接口返回了无效的上传地址')
  let etag: string | null
  try {
    const response = await ctx.http.request('PUT', prepared.presigned_url, {
      data: new Uint8Array(png), headers: { 'Content-Type': 'image/png' },
      responseType: 'text', redirect: 'error', timeout: 30_000, signal,
    })
    etag = response.headers.get('etag')
  } catch {
    signal.throwIfAborted()
    // A signed upload URL contains credentials; keep it out of plugin logs.
    throw new Error('上传 QQ Markdown 图片失败')
  }
  const uploadedMd5 = etag?.replace(/^"|"$/g, '').toLowerCase()
  if (uploadedMd5 !== md5) throw new Error('QQ 素材上传的 ETag 与图片 MD5 不一致')
  signal.throwIfAborted()
  const image = await api.completeMediaImage!({ upload_id: prepared.upload_id, md5: uploadedMd5 })
  let disposed = false
  const dispose = async () => {
    if (disposed || !image.image_id) return
    disposed = true
    try { await api.deleteMediaImage!(image.image_id) }
    catch (error) {
      if ((error as { code?: number })?.code !== 40035008) ctx.logger('blipreview').warn('清理 QQ 预览素材失败：%s', errorSummary(error))
    }
  }
  if (!image.image_id || !/^qqbot-media:\/\/image\/v1\/[^\s()<>"']+$/.test(image.url)) {
    await dispose()
    throw new Error('QQ 素材接口返回了无效的 Markdown 图片引用')
  }
  return { url: image.url, dispose }
}
