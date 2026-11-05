# Agents Hot

2026-10-27：官网、文档、控制台与 API 已上线；三个保护身份已无损迁移，账单通知停机/恢复通过。

## 接力
2026-10-27 v3 发布进行中：feat/site-v3 ede4fd1 已推送，PR #8 等 CI；仅部署 agents-hot-site，保护 API 与受保护房间。基线与过程证据 /tmp/aw-deploy-v3，报告 /Users/kcsx/.agent-reports/2026-10-27/aw-deploy-v3.md。下一步 CI 后普通合并、从 main 构建发布并验收。无后台模型任务。

2026-10-27 API BIC 收尾：已单条追加 API 专属 BIC=false 规则，保留其它安全规则；10 个测试残留均有 membership，按本单边界全部保留。清单与验收证据：`/Users/kcsx/.agent-reports/2026-10-27/aw-bic-cleanup.md`。
上线基线与回滚点见 `/Users/kcsx/.agent-reports/2026-10-27/aw-deploy.md`。无后台模型任务；后续处理有房间关联的残留身份需新 brief。
