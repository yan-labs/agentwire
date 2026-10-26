import { Room, type Env, H_AGENT, H_AGENT_NAME, H_TRUSTED_JOIN, H_TRUSTED_LEAVE } from "./room";
import { Directory, type GlobalAgent, sha256Hex } from "./directory";

export { Room, Directory };

function corsHeaders(): HeadersInit {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-max-age": "86400",
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...corsHeaders(),
    },
  });
}

function landing(base: string): Response {
  const html = `<!doctype html>
<html lang="en">
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>AgentWire</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; max-width: 720px; margin: 3rem auto; padding: 0 1.25rem; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
  pre { background: color-mix(in oklab, Canvas 85%, CanvasText 15%); padding: 1rem; overflow: auto; border-radius: 8px; }
  h1 { font-size: 1.6rem; margin: 0 0 .4rem; }
  .tag { opacity: .7; font-size: .9rem; }
  a { color: inherit; }
</style>
<h1>AgentWire</h1>
<p class="tag">HTTP inbox + webhook wake for agents that cannot share a process.</p>
<p>Create a room, register agents, send messages. Peers with a <code>webhook_url</code> get a fire-and-forget POST; pollers use <code>GET …/messages?after=</code>.</p>
<pre># create room
curl -sS -X POST ${base}/v1/rooms | jq

# register agents (admin_token)
curl -sS -X POST ${base}/v1/rooms/$ROOM/agents \\
  -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" \\
  -d '{"name":"lai-cai","webhook_url":"https://example.com/hook"}' | jq

curl -sS -X POST ${base}/v1/rooms/$ROOM/agents \\
  -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" \\
  -d '{"name":"muse"}' | jq

# send / poll
curl -sS -X POST ${base}/v1/rooms/$ROOM/messages \\
  -H "Authorization: Bearer $TOKEN_A" -H "Content-Type: application/json" \\
  -d '{"text":"hello muse"}' | jq

curl -sS "${base}/v1/rooms/$ROOM/messages?limit=20" \\
  -H "Authorization: Bearer $TOKEN_B" | jq
</pre>
<p><a href="/health">/health</a> · <a href="https://github.com/yan-labs/agentwire">github.com/yan-labs/agentwire</a></p>
</html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", ...corsHeaders() },
  });
}

function roomStub(env: Env, roomId: string) {
  return env.ROOM.getByName(roomId);
}

function rewriteToInternal(request: Request, internalPath: string): Request {
  const url = new URL(request.url);
  url.pathname = internalPath;
  return new Request(url.toString(), request);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method.toUpperCase();

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (method === "GET" && pathname === "/") {
      return landing(url.origin);
    }
    if (method === "GET" && pathname === "/health") {
      return json({ ok: true, service: "agentwire", ts: new Date().toISOString() });
    }

    // Never trust internal headers from clients.
    const clean = new Headers(request.headers);
    for (const k of [...clean.keys()]) if (k.toLowerCase().startsWith("x-aw-")) clean.delete(k);
    request = new Request(request, { headers: clean });

    const dir = env.DIRECTORY.getByName("global");
    const token = bearer(request);
    let me: GlobalAgent | null = null;
    const resolveMe = async () => (token ? (me ??= await dir.resolve(token)) : null);

    // ---- Global identity ----
    if (method === "POST" && pathname === "/v1/agents") {
      const body = await readJson(request);
      if (!body) return json({ error: "invalid json" }, 400);
      const name = String(body.name || "").trim();
      if (!name) return json({ error: "name required" }, 400);
      if (name.length > 64) return json({ error: "name too long" }, 400);
      const hook = parseWebhook(body);
      if ("error" in hook) return json({ error: hook.error }, 400);
      const { agent, token: t } = await dir.register(name, hook.webhook_url ?? null, hook.webhook_headers ?? null);
      return json({ ...publicAgent(agent), token: t }, 201);
    }
    if (pathname === "/v1/me" || pathname === "/v1/agents/me" || pathname === "/v1/me/rooms" || pathname === "/v1/me/token") {
      const a = await resolveMe();
      if (!a) return json({ error: token ? "unauthorized" : "missing bearer token" }, 401);
      if (method === "GET" && (pathname === "/v1/me" || pathname === "/v1/agents/me")) {
        return json({ ...publicAgent(a), rooms: await dir.rooms(a.id) });
      }
      if (method === "GET" && pathname === "/v1/me/rooms") {
        return json({ agent_id: a.id, rooms: await dir.rooms(a.id) });
      }
      if (method === "PATCH" && (pathname === "/v1/me" || pathname === "/v1/agents/me")) {
        const body = await readJson(request);
        if (!body) return json({ error: "invalid json" }, 400);
        const hook = parseWebhook(body);
        if ("error" in hook) return json({ error: hook.error }, 400);
        const patch: { name?: string; webhook_url?: string | null; webhook_headers?: string | null } = {};
        if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim().slice(0, 64);
        if ("webhook_url" in body) patch.webhook_url = hook.webhook_url ?? null;
        if ("webhook_headers" in body) patch.webhook_headers = hook.webhook_headers ?? null;
        const updated = await dir.update(a.id, patch);
        return json(publicAgent(updated!));
      }
      if (method === "DELETE" && (pathname === "/v1/me" || pathname === "/v1/agents/me")) {
        return json(await deleteIdentity(env, a.id, request.url));
      }
      if (method === "POST" && pathname === "/v1/me/token") {
        // Rotates ALL tokens of this identity (including a migrated legacy room token).
        return json({ agent_id: a.id, token: await dir.rotateToken(a.id) });
      }
      return json({ error: "not found" }, 404);
    }
    if (method === "GET" && /^\/v1\/agents\/[^/]+$/.test(pathname)) {
      const a = await dir.get(decodeURIComponent(pathname.slice(11)));
      if (!a) return json({ error: "not found" }, 404);
      return json({ agent_id: a.id, name: a.name, created_at: a.created_at });
    }

    // ---- Operator (OPERATOR_TOKEN secret): list / delete identities ----
    if (pathname === "/v1/admin/agents" || /^\/v1\/admin\/agents\/[^/]+$/.test(pathname)) {
      if (!env.OPERATOR_TOKEN || !token || !(await safeEqual(token, env.OPERATOR_TOKEN))) return json({ error: "operator token required" }, 403);
      if (method === "GET" && pathname === "/v1/admin/agents") return json({ agents: await dir.listAgents() });
      if (method === "DELETE" && pathname !== "/v1/admin/agents") {
        const id = decodeURIComponent(pathname.slice("/v1/admin/agents/".length));
        if (!(await dir.get(id))) return json({ error: "not found" }, 404);
        return json(await deleteIdentity(env, id, request.url));
      }
      return json({ error: "not found" }, 404);
    }

    // ---- Invites ----
    const inv = /^\/v1\/invites\/([^/]+)\/accept$/.exec(pathname);
    if (method === "POST" && inv) {
      const a = await resolveMe();
      if (!a) return json({ error: "global agent token required" }, 401);
      const roomId = await dir.redeemInvite(decodeURIComponent(inv[1]));
      if (!roomId) return json({ error: "invite invalid or expired" }, 404);
      const h = new Headers({ "content-type": "application/json", [H_TRUSTED_JOIN]: "1" });
      const res = await roomStub(env, roomId).fetch(
        new Request(new URL("/internal/members", request.url).toString(), {
          method: "POST",
          headers: h,
          body: JSON.stringify({ agent_id: a.id, name: a.name }),
        })
      );
      return withCors(res);
    }

    // POST /v1/rooms  (with a global token the caller becomes owner + first member)
    if (method === "POST" && pathname === "/v1/rooms") {
      const owner = await resolveMe();
      if (token && !owner) return json({ error: "unauthorized" }, 401);
      const roomId = `room_${[...crypto.getRandomValues(new Uint8Array(12))]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")}`;
      const stub = roomStub(env, roomId);
      const res = await stub.fetch(
        rewriteToInternal(
          new Request(request.url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ room_id: roomId, owner_id: owner?.id, owner_name: owner?.name }),
          }),
          "/internal/create"
        )
      );
      return withCors(res);
    }

    // /v1/rooms/:id/...
    const m = /^\/v1\/rooms\/([^/]+)(\/.*)?$/.exec(pathname);
    if (!m) {
      return json({ error: "not found" }, 404);
    }
    const roomId = decodeURIComponent(m[1]);
    const rest = m[2] || "";
    const stub = roomStub(env, roomId);

    let internal = "";
    let resolvedName: string | null = null;
    if (method === "GET" && rest === "") internal = "/internal/meta";
    else if (method === "DELETE" && rest === "") internal = "/internal/room";
    else if (method === "POST" && rest === "/agents") internal = "/internal/agents";
    else if (method === "PATCH" && rest === "/agents/me") internal = "/internal/agents/me";
    else if (
      (method === "PUT" || method === "PATCH") &&
      rest === "/webhook"
    ) {
      // alias: PUT/PATCH /webhook → PATCH agents/me with {webhook_url}  (per-room override)
      internal = "/internal/agents/me";
    } else if (method === "POST" && rest === "/messages") internal = "/internal/messages";
    else if (method === "GET" && rest === "/messages") internal = "/internal/messages";
    else if (method === "GET" && rest === "/stream") internal = "/internal/stream";
    else if (method === "GET" && /^\/pending\/[^/]+$/.test(rest)) internal = "/internal" + rest;
    else if (method === "GET" && rest === "/pending") internal = "/internal/pending";
    else if (method === "POST" && rest === "/read") internal = "/internal/read";
    else if (method === "POST" && rest === "/members") {
      const body = await readJson(request.clone());
      const target = body && body.agent_id ? await dir.get(String(body.agent_id)) : null;
      if (!target) return json({ error: "unknown agent_id (the agent must register via POST /v1/agents first)" }, 404);
      resolvedName = target.name;
      internal = "/internal/members";
    } else if (method === "DELETE" && /^\/members\/[^/]+$/.test(rest)) internal = "/internal" + rest;
    else if (method === "POST" && rest === "/invites") {
      // authorize against the room, then mint the code in the Directory
      if (token && url.searchParams.get("token") === null) await resolveMe();
      const h = new Headers(request.headers);
      if (me) h.set(H_AGENT, (me as GlobalAgent).id);
      const authRes = await stub.fetch(new Request(new URL("/internal/authz", request.url).toString(), { method: "GET", headers: h }));
      if (!authRes.ok) return withCors(authRes);
      const auth = (await authRes.json()) as { agent_id: string | null };
      const body = (await readJson(request)) || {};
      const uses = Math.min(Math.max(parseInt(String(body.uses ?? 1), 10) || 1, 1), 100);
      const ttl = Math.min(Math.max(parseInt(String(body.ttl_seconds ?? 86400), 10) || 86400, 60), 30 * 86400);
      const invite = await dir.createInvite(roomId, auth.agent_id, uses, ttl);
      return json({ ...invite, accept_url: `${url.origin}/v1/invites/${invite.code}/accept` }, 201);
    } else if (method === "POST" && rest === "/migrate") internal = "/internal/migrate";
    else if (method === "GET" && rest === "/members") internal = "/internal/members";
    else if ((method === "PUT" || method === "DELETE") && /^\/admins\/[^/]+$/.test(rest)) internal = "/internal" + rest;
    else if (method === "POST" && rest === "/owner") internal = "/internal/owner";
    else return json({ error: "not found" }, 404);

    const internalUrl = new URL(request.url);
    internalUrl.pathname = internal;
    const fwd = new Request(internalUrl.toString(), request);
    if (internal !== "/internal/pending/" && !internal.startsWith("/internal/pending/")) {
      const t = token || url.searchParams.get("token");
      if (t) {
        const g = t === token ? await resolveMe() : await dir.resolve(t);
        if (g) fwd.headers.set(H_AGENT, g.id);
      }
    }
    if (resolvedName !== null) fwd.headers.set(H_AGENT_NAME, encodeURIComponent(resolvedName));
    const res = await stub.fetch(fwd);
    return withCors(res);
  },
} satisfies ExportedHandler<Env>;

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders())) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}

function bearer(req: Request): string | null {
  const h = req.headers.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const v = await req.json();
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parseWebhook(body: Record<string, unknown>): { webhook_url?: string | null; webhook_headers?: string | null } | { error: string } {
  const out: { webhook_url?: string | null; webhook_headers?: string | null } = {};
  if (body.webhook_url !== undefined) {
    if (body.webhook_url === null || body.webhook_url === "") out.webhook_url = null;
    else {
      const raw = String(body.webhook_url).trim();
      try {
        const u = new URL(raw);
        if (u.protocol !== "https:" && u.protocol !== "http:") return { error: "webhook_url must be http(s)" };
      } catch {
        return { error: "invalid webhook_url" };
      }
      out.webhook_url = raw;
    }
  }
  if (body.webhook_headers !== undefined) {
    const raw = body.webhook_headers;
    if (raw === null) out.webhook_headers = null;
    else {
      if (typeof raw !== "object" || Array.isArray(raw)) return { error: "webhook_headers must be an object of string values" };
      const h: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (!/^[A-Za-z0-9-]{1,64}$/.test(k) || typeof v !== "string" || v.length > 4096) return { error: "webhook_headers must be an object of string values" };
        h[k] = v;
      }
      out.webhook_headers = Object.keys(h).length ? JSON.stringify(h) : null;
    }
  }
  return out;
}

function publicAgent(a: GlobalAgent) {
  return {
    agent_id: a.id,
    name: a.name,
    webhook_url: a.webhook_url,
    has_webhook: Boolean(a.webhook_url),
    has_webhook_headers: Boolean(a.webhook_headers),
    created_at: a.created_at,
  };
}

async function safeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0;
}

/** Remove an identity from every room (handing off ownership), then delete it and all its tokens. */
async function deleteIdentity(env: Env, id: string, base: string) {
  const dir = env.DIRECTORY.getByName("global");
  const rooms = await dir.rooms(id);
  const left = [];
  for (const r of rooms) {
    const res = await env.ROOM.getByName(r.room_id).fetch(
      new Request(new URL(`/internal/members/${encodeURIComponent(id)}`, base).toString(), { method: "DELETE", headers: { [H_TRUSTED_LEAVE]: "1" } })
    );
    const j = (await res.json().catch(() => ({}))) as { new_owner?: string | null };
    left.push({ room_id: r.room_id, status: res.status, new_owner: j.new_owner ?? null });
  }
  await dir.deleteAgent(id);
  return { ok: true, deleted: id, rooms_left: left };
}
