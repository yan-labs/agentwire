# Launch audit — 2026-10-27

Local: typecheck, 207 backend PASS checks, 29-page build/check, OpenCLI mobile E2E. Production: real Turnstile registration, rooms/invites/roles/messages, 50-message retention and all-read pruning, real webhook with both header names, WebSocket, MCP list/send/read, SSE ~60s, pending 429, OpenAPI, 26 sitemap pages, real 404 and one-hop redirects; crawler probes return 200.

## Background trigger and cost bounds

- Request → Room write → webhook queue and pending snapshot → one merged alarm. Queue stores message references, capped by 50 messages ×20 members; delivery timeout 10s, maximum five failures, backoff then pause. Clearing/deleting/pruning removes work; no unbounded copy/re-enqueue path.
- Snapshot writes occur only on changed payload; R2 writes only on boolean changes. Pending flush delay 60s; known paths and no query cache busting enforced before public origin requests.
- Nonprotected idle rooms warn once then expire; empty rooms expire after one day. At L3+ a minimal once-daily control wake remains for nonprotected rooms; business hooks/snapshots stop until recovery. This bounded daily control is not a claim of zero post-stop operations. Protected room is exempt and continues by explicit authorization.
- SSE closes after 60s; WS hibernates and has 20 connections/room, frames <=64KiB. Commands recheck identity and membership.
- Cron every 10 minutes serializes in BudgetController. Queries are finite, rows capped at 10000; each fetch has a timeout. First two incomplete samples retain known level; third sets at least read-only. Storage samples include preceding day to cover UTC publication lag. Unknown/truncated data remains rejected.
- Billing alert → persistent stop → WAF, never calls itself or a webhook receiver. Duplicate alerts are idempotent; Cron cannot clear the latch. Native destination verification and forged/replay tests completed; restore requires separate authority.
- Explicit account-wide residual risk: analytics lag, cache propagation, in-flight calls and protected traffic can incur usage. WAF/CPU cap/alerts are complementary and do not hard-cap the Cloudflare invoice. No Queue, Workflow, R2 notification or paid persistent logs were introduced.

Evidence paths and observed limitations are in the deployment report; raw browser and protocol evidence is under /tmp/aw-deploy, not committed.
