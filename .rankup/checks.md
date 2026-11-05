# Checks

## Bing 旧 URL（2026-11-05）
- ✅ Bing 标记的短标题和描述均属于 `/zh`、`/zh/docs`、`/zh/docs/integration`、`/blog` 四个现已返回 404 的旧站 URL；不为不存在的页面编造元数据或无关跳转。最终验证及来源见 `/Users/kcsx/.agent-reports/2026-11-05/agents-hot-bing-fix.md`。

## Sitemap lastmod（2026-11-05）
- ✅ 本地构建 26/26 URL 带日期；模拟 quickstart 内容提交只更新该页，随后 robots 提交不改变日期；构建、typecheck、现有测试与站点检查通过。
- ✅ 生产站点版本 `46efc44c-7e4e-4116-b355-b325ca90c8ca` 100%；线上 26/26 日期与构建一致。GSC 重新提交成功；Bing 已提交、正在处理。抓取仍待平台更新。详见 `/Users/kcsx/.agent-reports/2026-11-05/agents-lastmod-auto.md`。
