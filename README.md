# 幸运莉莉娅插件 - B站视频预览

支持 BV 号、av 号、B站视频链接、b23.tv 短链和 QQ 小程序卡片解析，将 UP 主、播放、弹幕、时长和上传时间直接绘入预览图片。支持 Markdown 时，标题、简介、点赞等数据及 AI 总结使用 Markdown 发送；其他平台自动发送完整图文卡片。

开发验证：运行 `npm ci`、`npm test` 和 `npm run build`。

发布：提交改动后运行 `npm version patch`，再执行 `git push origin main --follow-tags`。GitHub Actions 会在 `v*` 标签通过测试和构建后，使用 npm 可信发布自动发布；预发布版本使用 `next`，其余版本使用 `latest`。主分支、PR 和手动运行只做验证。
