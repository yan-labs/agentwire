# Checks

## Bing 旧 URL（2026-11-05）
- ✅ Bing 标记的短标题和描述均属于 `/zh`、`/zh/docs`、`/zh/docs/integration`、`/blog` 四个现已返回 404 的旧站 URL；不为不存在的页面编造元数据或无关跳转。最终验证及来源见 `/Users/kcsx/.agent-reports/2026-11-05/agents-hot-bing-fix.md`。

## Sitemap lastmod（2026-11-05）
- ✅ 本地构建 26/26 URL 带日期；模拟 quickstart 内容提交只更新该页，随后 robots 提交不改变日期；构建、typecheck、现有测试与站点检查通过。
- ⏸ 生产发布、生产三页回读及 GSC/Bing 提交待完成：仓库现有 GitHub Actions 仅 Checks，未找到要求的团队部署流水线。详见 `/Users/kcsx/.agent-reports/2026-11-05/agents-lastmod-auto.md`。
