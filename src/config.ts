import { Schema } from '@luckylillia/plugin-sdk'
import type { AiModelSelection } from 'lucky-lillia-aiprovider'

export interface Config {
  cacheDuration: number
  summaryMode: 'none' | 'official' | 'llm'
  model: AiModelSelection
  maxSubtitleLength: number
  account: string
  cookie: string | null
  refreshToken: string | null
  loginRevision: string
  qrLogin: { enabled: boolean }
}

// Null means explicitly cleared. A null default keeps that intent through the host's default merge.
const loginSecret = () => Schema.union([Schema.string().role('secret'), Schema.const(null)]).role('secret').default(null)

export const Config: Schema<Config> = Schema.object({
  cacheDuration: Schema.number().min(0).max(86400).default(60).description('同一机器人、同一会话内同一视频的去重时间（秒）；0 表示关闭'),
  summaryMode: Schema.union([
    Schema.const('none').description('不总结'),
    Schema.const('official').description('B站官方 AI 总结（需要 B站登录）'),
    Schema.const('llm').description('字幕总结（需要 B站登录和 AI 服务插件）'),
  ]).default('none').description('AI 总结方式'),
  model: Schema.object({
    ai: Schema.string().default(''),
    model: Schema.string().default(''),
  }).role('ai-model').description('字幕总结使用的 AI 服务和模型'),
  maxSubtitleLength: Schema.natural().min(1000).max(200000).default(30000).description('提交给 AI 的字幕字符数上限'),
  // Preserve existing login profiles while keeping their storage key internal.
  account: Schema.string().pattern(/^[a-zA-Z0-9_-]{1,64}$/).default('default').hidden(),
  cookie: loginSecret().description('B站 Cookie；扫码后自动填入，手动修改或清空后保存生效'),
  refreshToken: loginSecret().description('与 Cookie 配套的 refresh_token，用于自动续期；扫码后自动保存，手动导入可留空'),
  // Distinguish an explicit credential edit, including clearing, from an ordinary reload.
  loginRevision: Schema.string().pattern(/^[a-zA-Z0-9_-]{0,80}$/).default('').hidden(),
  qrLogin: Schema.object({
    enabled: Schema.boolean().default(true).description('启用「登录B站」指令，在聊天窗口发送二维码供手机 B站 App 扫码登录'),
  }).description('登录指令'),
})
