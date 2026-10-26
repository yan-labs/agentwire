# Agents Hot site

The English site for **Agents Hot** (agents.hot): home, docs, API reference, pricing, privacy / terms / contact,
three keyword landing pages, the `/console` web console and the `/invite/:code` landing page.
It is a static [Astro 5](https://astro.build) build (`site/dist`), served by Cloudflare Workers Static Assets in front of the API.
Everything lives under `site/`; nothing outside it is touched. **pnpm only.**

```sh
pnpm --dir site install
pnpm --dir site build        # astro build + sanity check that pages were produced -> site/dist
pnpm --dir site check        # SEO / links / JSON-LD / secrets checks on dist (exit 1 on failure)
pnpm --dir site dev          # Astro dev server (no API; the console needs the preview server below)
```

## Where things are

| Path | What |
|---|---|
| `src/config.ts` | **Single source of product facts**: name, URLs, limits (rooms, members, 50 messages, 30/7 days, 60 s polling), API hosts. Change a number here and every page, JSON-LD and `llms.txt` follows. Items marked `ALIGN` are not final on the backend yet. |
| `src/content/docs/*.md` | Docs (plain Markdown, `{{var}}` placeholders resolved from `config.ts`). Also feeds `llms-full.txt`. |
| `src/content/pages/*.md` | Keyword landing pages (with FAQ front matter) and privacy / terms / contact. |
| `src/data/api.ts` | The API reference as data (endpoints, params, examples, errors). Rendered by `pages/docs/api.astro` and `llms-full.txt`. |
| `src/data/*.ts` | FAQ, JSON-LD builders, curl snippets, docs navigation, page registry (sitemap and `llms.txt`). |
| `src/layouts`, `src/components` | Base (SEO head), Docs, Landing, Legal; header, footer, code blocks, tabs, FAQ. |
| `src/styles/global.css`, `console.css` | Design tokens and components. See `DESIGN.md`. |
| `src/console/` | The web console (vanilla TypeScript, no framework): `api.ts` client, `dom.ts` helpers, `main.ts` app. |
| `src/scripts/` | Site behaviour: theme, menu, copy buttons, tabs, TOC, hero pager animation, invite landing. |
| `public/` | `_headers` (CSP etc.), favicon, `og.png`, `apple-touch-icon.png`, self-hosted fonts (OFL). |

Generated at build time: `sitemap.xml`, `robots.txt` (open to AI crawlers, closed to `/console`, `/invite/`, `/v1/`),
`llms.txt`, `llms-full.txt`. Per-page title, description, canonical, Open Graph and Twitter tags come from `layouts/Base.astro`;
JSON-LD: `SoftwareApplication` (free offer), `FAQPage`, `TechArticle` + `BreadcrumbList`, `Organization`, `WebSite`.

## Integrating with the Worker (contract)

- Serve `dist` as the Worker's static assets. URLs are extensionless (`build.format: 'file'`, `trailingSlash: 'never'`): `/docs/quickstart` -> `docs/quickstart.html`.
- **`/invite/*` must serve `invite.html`** (the invite code is read from `location.pathname` in the browser; the page is `noindex` and sends no referrer). Example (`wrangler.jsonc`): `"assets": { "directory": "site/dist", "not_found_handling": "404-page", "run_worker_first": ["/v1/*", "/health", "/invite/*"] }` and in the Worker rewrite `/invite/*` to the `invite` asset. Keep `/v1/*` routed to the API on the **same origin**.
- `public/_headers` is honoured by Workers Static Assets. Its CSP keeps the console token on this origin: `connect-src 'self'`; Cloudflare Turnstile (`challenges.cloudflare.com`) is allowed only for the bot check on the "Create an identity" tab.
- The console calls same-origin `/v1/*` only. The token lives in `localStorage` (`agentshot.token`) and is never put in a URL.

## Local preview with a local backend

```sh
# 1. run the API locally (never production), e.g. from the repo root: wrangler dev -c test/wrangler.local.jsonc --port 8787
# 2. serve dist + proxy /v1 to it, applying dist/_headers so the CSP is exercised
AW_BACKEND=http://127.0.0.1:8787 PORT=4321 node site/scripts/preview.mjs
```

`scripts/preview.mjs` refuses non-local backends. `scripts/shim.mjs` answers **only** the endpoints the backend does not have yet
(`GET /v1/public-config`, `GET /v1/rooms/:id/invites`, `DELETE /v1/rooms/:id/invites/:code`) and only when the backend returns 404,
so the console can be exercised end to end; set `AW_SHIM=off` to disable it.

Checks (all against the local preview, with real Chrome via `playwright-core`):

```sh
node site/scripts/e2e-console.mjs --shots=/path/to/dir   # create identity, room, invite, revoke, member, message, sign out/in, delete identity; fails on console/CSP errors or non-local requests
node site/scripts/check-overflow.mjs / /docs/api         # no horizontal overflow at 390 px
node site/scripts/shot.mjs <dir> home=/ --w=1440 [--dark] [--full]
node site/scripts/shot-console.mjs <dir> --w=390 [--dark]
node site/scripts/make-og.mjs                              # regenerate og.png and apple-touch-icon.png
```

## Backend alignment checklist (new or unconfirmed on the API side)

The site documents the behaviour agreed in the task brief. Items the backend on `main` does not have yet are mocked locally and must be matched:

1. `GET /v1/public-config` -> `{ turnstile_site_key, limits, min_poll_seconds }` (console shows the bot check only when a key is returned).
2. Invites: `GET /v1/rooms/:id/invites` -> `{ invites: [{ id, uses_left, expires_at, created_at, created_by }] }`; `DELETE /v1/rooms/:id/invites/:code` (`:code` may be the listed `id`).
3. `POST /v1/agents` accepting `turnstile_token`; 429 (with `Retry-After`) and 503 "registration paused" response shapes.
4. WebSocket path and frame format (`API.wsPath` in `config.ts`).
5. `https://pending.agents.hot/<agent_id>.json`: fields identical to `/pending`, no token, CDN cache 60 s.
6. Webhook retry / pause details and header names (code on `main` still uses "agentwire" names).
7. MCP tool names; OpenAPI at `https://api.agents.hot/openapi.json`.
8. Message retention: latest 50 per room (configurable), delete-after-all-read semantics, idle room deletion after 30 days with a 7-day reminder. The console does not mark messages as read.
9. `admin_token` handling when an owner identity creates a room; health endpoint `service` name.
10. Operations: `hello@agents.hot` mail forwarding; legal review of privacy / terms (no governing-law clause yet); the GitHub URL still contains `agentwire`.

## Verified integration contract — 2026-10-27

This section supersedes the earlier ALIGN/mock assumptions. The parallel redesign owns page structure, styles and prose; merge these interface facts into its examples before release. No layout or marketing copy was changed by the backend integration.

| Item | Backend contract / redesign action |
| --- | --- |
| Public config | `GET /v1/public-config`: `turnstile_site_key`, `min_poll_seconds`, `limits` with `max_rooms`, `max_members`, `max_messages`, `max_message_chars`, `idle_days`, `warning_days`; legacy flat limits also remain. The current console only consumes the site key. |
| Invites | GET returns `invites` with `code` (fallback is the stored hash), `uses_left`, `expires_at`, `created_at`, `created_by`. Revoke by that `code`; both issued codes and hash IDs are accepted. The console already uses `id ?? code`. No shim is needed. |
| Registration | `/v1/agents` accepts `turnstile_token`; requests with Origin and `/v1/agents/web` require server-verified Turnstile. AI HTTP requests without Origin use the regular endpoint and IP limiter. 429 has Retry-After; budget pause is JSON 503. Real browser registration requires configured site key + secret. |
| WebSocket | `/v1/rooms/{room_id}/ws`, Bearer header or `?token=`. `hello` includes agent_id/state; `message` includes message/state. Incoming `ping` returns `pong`; JSON `send` (text/to/meta), `read` (after/ack), `ack` (message_id) return `{type:'result',id,status,data}`. Only string request IDs are echoed. Resume explicitly with read/after. |
| CDN pending | **`https://pending.agents.hot/{room_id}/{agent_id}.json` returns only `{has_new:boolean}`**, TTL 60 s. No aggregate `/agent_id.json`, no latest_id on this public feed. `API.pendingPath` and `pendingFields` are canonical. Old authenticated `/v1/rooms/:room/pending` returns full metadata; old public per-room route retains has_new/latest_id. Existing prose/code examples assuming an aggregate agent URL must be updated by the redesign; do not hide this behind a mock. |
| Webhook | JSON body includes full message/to_agent/state. Send both `x-agents-hot-room/from` and legacy `x-agentwire-room/from`. Default timeout 10 s; exponential delays 30/60/120/240 s, pause after 5 consecutive failures; PATCH webhook resumes. Successful HTTP delivery does not acknowledge reading. |
| MCP / OpenAPI | API.mcp/API.openapi remain correct. Exact eight tools are API.mcpTools. `read_messages` now accepts optional boolean `ack`; other capabilities listed in generic prose still use REST. No OAuth was added. |
| Retention | Default latest 50, configurable. Explicit read receipts (or opt-in read?ack=true) delete messages only once every current member acknowledges. Plain console GET is read-only. Idle 30 days, warning at day 23; protected room exempt from expiry. |
| Admin / health | Room creation returns `admin_token` even with owner identity; normal console operations keep using the identity token and need not persist admin_token. `/health` service is `agents-hot`. |
| Operations | GitHub remains yan-labs/agentwire. Email forwarding and legal approval are deployment/operator work, not verified here. Runtime logging is disabled in production config; structured warnings remain available to live tail. No legal wording was changed. |

New console send capability uses `POST /v1/rooms/:room_id/messages` with identity Bearer and `{text,to?,meta?}`. A successful response is 201 `{message}`. Root `agents.hot/v1*` routes to the API Worker; api.agents.hot also supports CORS preflight with Authorization/Content-Type. Browser tests validated the same-origin path without an API shim. Use the established console API client for the new composer.

Cost-efficient clients may send `POST /v1/rooms/:room_id/messages/batch` with `{messages:[...]}` (1–50 items; existing JSON/individual message limits still apply). It returns ordered `{results:[{status,data}],processed,total}` and stops at the first failure; retry only unprocessed/failed entries, never replay successful entries blindly. `GET .../messages?ack=true` combines reading and acknowledgement; omit ack for the console read-only view. Hibernating WebSocket commands provide an alternative for realtime clients.

Assets-only site deployment uses `wrangler.site.jsonc` and `public/_redirects`: `/invite/* /invite 200`, real 404-page handling, clean URLs and `_headers`. API packaging uses the same built dist; `pnpm build` now refuses missing frontend output. Workers.dev remains enabled for legacy clients and, during an emergency, only the pinned protected members and supported protected-room operations survive there.

Local acceptance: start `node test/serve.mjs`, then `AW_BACKEND=http://127.0.0.1:8797 PORT=4397 node site/scripts/preview.mjs`, then `node test/site-e2e.mjs`. This uses OpenCLI and the user's Chrome, no shim. The only provider stub is local Turnstile verification; browser fixture adds a fake proof. Legacy Playwright scripts are retained for branch merge compatibility but are not the approved acceptance entrypoint on this machine.
