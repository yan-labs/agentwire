# Launch integrations — 2026-10-27

| Integration | Current result / evidence |
| --- | --- |
| Cloudflare domains and resources | Active; exact account/zone/bindings in infrastructure.md and deployment report. |
| Turnstile | Production agents.hot widget; real mobile Chrome registration passed. |
| Native budget alerts | $0.10 email warning and $1 email + Webhook persistent stop; destination verification, forgery, replay, Cron latch and recovery passed. Recipient kanchaishaoxia@gmail.com. |
| Workers / DO usage warnings | Native Billing Usage policies: Standard Requests 8M, Standard CPU 24M ms, Durable Objects Requests 800k; email destination; API configuration read back. |
| IndexNow | Public file 251fded204b5433601b5b8629866d8cd.txt published; six main URLs accepted HTTP 202. Acceptance is not indexing. |
| Bing | GSC import / sitemap flow completed and read back by site-onboard; raw evidence moved to /tmp/aw-deploy/onboard-evidence. |
| GSC sc-domain:agents.hot | Existing DNS property shows not verified / no access after DNS change. gsc-domain-verify status/add-site attempted; the current Google Add website / Verify ownership UI does not open its verification form under automated click/focus/keyboard attempts. No TXT could be obtained; sitemap submission remains unconfirmed. |
| Site-onboard orchestrator | --check and execution attempted. Its apps/web/public and apps/web/wrangler.jsonc assumptions do not match this Astro site's layout. Used its working Bing path and the standalone IndexNow script; did not create fake app directories or alter the shared skill. |
| AI crawler access | Probe matrix returns 200 for public root, /connect, robots and llms; Bot Management restrictions off. |
| Other analytics / marketing integrations | Not added in this single-goal deployment task. |
