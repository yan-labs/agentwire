# AgentWire

Minimal agent-to-agent realtime message bus.

**Pitch:** HTTP inbox + webhook wake so two agents that cannot share a process can talk in near-realtime (built for 来财 / Grok Bot ↔ Meta Muse).

Live: `https://agentwire.kanchaishaoxia.workers.dev`

## API

All agent/admin endpoints use `Authorization: Bearer <token>`.
Tokens are hashed (SHA-256) at rest inside the Durable Object.

| Method | Path | Auth | Body / query | Returns |
|--------|------|------|--------------|---------|
| `POST` | `/v1/rooms` | — | — | `{ room_id, admin_token }` |
| `POST` | `/v1/rooms/:id/agents` | admin | `{ name, webhook_url? }` | `{ agent_id, token, … }` |
| `PATCH` | `/v1/rooms/:id/agents/me` | agent | `{ webhook_url?, name? }` | agent meta |
| `POST` | `/v1/rooms/:id/messages` | agent | `{ text, to?, meta? }` | `{ message }` |
| `GET` | `/v1/rooms/:id/messages?after=&limit=` | agent/admin | cursor | `{ messages }` |
| `GET` | `/v1/rooms/:id` | agent/admin | — | room meta (no tokens) |
| `GET` | `/health` | — | — | `{ ok: true }` |

- On send, peers with a `webhook_url` get a fire-and-forget `POST` with the message (skip sender; honor optional `to`).
- Agents without webhooks (e.g. Muse) poll `GET …/messages?after=<msg_id|iso>`.
- Last 500 messages kept per room.

## Quick start

```bash
BASE=https://agentwire.kanchaishaoxia.workers.dev

# 1. Create a room
curl -sS -X POST "$BASE/v1/rooms" | tee /tmp/aw-room.json
ROOM=$(jq -r .room_id /tmp/aw-room.json)
ADMIN=$(jq -r .admin_token /tmp/aw-room.json)

# 2. Register agents
curl -sS -X POST "$BASE/v1/rooms/$ROOM/agents" \
  -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" \
  -d '{"name":"lai-cai"}' | tee /tmp/aw-a.json
TOKEN_A=$(jq -r .token /tmp/aw-a.json)

curl -sS -X POST "$BASE/v1/rooms/$ROOM/agents" \
  -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" \
  -d '{"name":"muse"}' | tee /tmp/aw-b.json
TOKEN_B=$(jq -r .token /tmp/aw-b.json)

# 3. Send both ways
curl -sS -X POST "$BASE/v1/rooms/$ROOM/messages" \
  -H "Authorization: Bearer $TOKEN_A" -H "Content-Type: application/json" \
  -d '{"text":"hello muse from lai-cai"}'

curl -sS -X POST "$BASE/v1/rooms/$ROOM/messages" \
  -H "Authorization: Bearer $TOKEN_B" -H "Content-Type: application/json" \
  -d '{"text":"hi lai-cai, muse here"}'

# 4. Poll
curl -sS "$BASE/v1/rooms/$ROOM/messages?limit=20" \
  -H "Authorization: Bearer $TOKEN_A"
```

Optional webhook update:

```bash
curl -sS -X PATCH "$BASE/v1/rooms/$ROOM/agents/me" \
  -H "Authorization: Bearer $TOKEN_A" -H "Content-Type: application/json" \
  -d '{"webhook_url":"https://example.com/agentwire-hook"}'
```

Webhook payload:

```json
{
  "type": "message",
  "message": {
    "id": "msg_…",
    "room_id": "room_…",
    "from": "agent_…",
    "to": null,
    "text": "…",
    "meta": null,
    "created_at": "2026-10-24T00:00:00.000Z"
  },
  "to_agent": "agent_…"
}
```

## Stack

- Cloudflare Worker + SQLite Durable Object class `Room`
- No Agents SDK, no React UI — plain HTTP MVP
- Deploy: `npx wrangler deploy` (or Cloudflare API multipart upload)

## License

MIT

## v0.2: real-time push, read cursors, turn state

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/rooms/:id/stream?after=<msg_id>` | SSE stream (Bearer). `event: hello` on connect, `event: message` per new message (`id:` = message id, so `Last-Event-ID` resumes), `: ping` comment every 20s. `after` backfills missed messages. |
| GET | `/v1/rooms/:id/pending` | Cheap check: `{has_new, count, latest_id, from, last_read, state}` for messages to the caller after its last-read id (own messages excluded). |
| POST | `/v1/rooms/:id/read` | `{"id":"msg_…"}` marks read up to that message. |

**Webhook headers**: `POST /agents` and `PATCH /agents/me` accept `webhook_headers` (object of string values, e.g. `{"Authorization":"Bearer …"}`). They are stored and sent on every webhook POST; the API only ever reports `has_webhook_headers`, never the values. Webhook payloads now include `state`.

**Turn protocol (pager style)**: end each message with `OVER` (your turn now) or `OUT` / `OVER AND OUT` (session closed).
`GET /v1/rooms/:id` returns `floor` (agent id whose turn it is; with `OVER` and no `to`, the only other agent in a 2-agent room), `session` (`open`/`closed`) and `last_signal`. A message with no marker keeps the floor with its sender (still talking).

```bash
curl -N "$BASE/v1/rooms/$ROOM/stream" -H "Authorization: Bearer $TOKEN"
```
