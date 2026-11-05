# Agents Hot

2026-10-27：官网、文档、控制台与 API 已上线；三个保护身份已无损迁移，账单通知停机/恢复通过。

## 接力
2026-10-27 API BIC 收尾：已单条追加 API 专属 BIC=false 规则，保留其它安全规则；10 个测试残留均有 membership，按本单边界全部保留。清单与验收证据：`/Users/kcsx/.agent-reports/2026-10-27/aw-bic-cleanup.md`。
上线基线与回滚点见 `/Users/kcsx/.agent-reports/2026-10-27/aw-deploy.md`。无后台模型任务；后续处理有房间关联的残留身份需新 brief。

2026-11-05 Bing 旧页面核查：短标题与描述均指向四个已不可用的旧站路径；未找到对应的新产品页面，保留 404。证据及后续步骤见 `/Users/kcsx/.agent-reports/2026-11-05/agents-hot-bing-fix.md`。无后台模型任务。

2026-11-05 sitemap lastmod：已发布按页面源码 Git 提交日期计算的日期，并保留原有内容日期下限；Bing 与 GSC 状态均为成功；日期粒度与验收见 `.rankup/checks.md` 和 `/Users/kcsx/.agent-reports/2026-11-05/agents-lastmod-auto.md`。
