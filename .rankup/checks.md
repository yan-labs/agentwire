# Checks

## Bing 旧 URL（2026-11-05）
- ✅ Bing 标记的短标题和描述均属于 `/zh`、`/zh/docs`、`/zh/docs/integration`、`/blog` 四个现已返回 404 的旧站 URL；不为不存在的页面编造元数据或无关跳转。最终验证及来源见 `/Users/kcsx/.agent-reports/2026-11-05/agents-hot-bing-fix.md`。

## Sitemap lastmod（2026-11-05，修订）
- ✅ 本地构建 26/26 URL 带日期；模拟修改 MCP 工具列表仅刷新实际展示的 API 页，修改 prompt 正文仅刷新 connect 和 docs/prompt，修改 quickstart 仅刷新该页；未使用的配置字段、公共脚本和 robots 同时修改不刷新。构建、typecheck、现有测试与站点检查通过。
- ✅ 已从合入 main 的 `23b739223c1c46f3d8c9dc4b0576121a9f9db8de` 构建并发布站点版本 `9af18749-e389-4020-b89c-87b5442c7d8b`（100%）；线上 26/26 与构建一致，10 月 26 日 4 页、10 月 27 日 13 页、11 月 1 日 9 页。
- ✅ GSC 和 Bing 已重新提交 sitemap；提交后 GSC 显示成功、26 个 URL，Bing 显示正在处理、已有 26 个 URL；抓取日期均只有日期粒度，不能证明本次部署后的抓取。详细证据见 `/Users/kcsx/.agent-reports/2026-11-05/agents-lastmod-auto.md`。
