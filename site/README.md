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
