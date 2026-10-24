import { Room, type Env } from "./room";

export { Room };

function corsHeaders(): HeadersInit {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, PATCH, PUT, OPTIONS",
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

    // POST /v1/rooms
    if (method === "POST" && pathname === "/v1/rooms") {
      const roomId = `room_${[...crypto.getRandomValues(new Uint8Array(12))]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")}`;
      const stub = roomStub(env, roomId);
      const res = await stub.fetch(
        rewriteToInternal(
          new Request(request.url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ room_id: roomId }),
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
    if (method === "GET" && rest === "") internal = "/internal/meta";
    else if (method === "POST" && rest === "/agents") internal = "/internal/agents";
    else if (method === "PATCH" && rest === "/agents/me") internal = "/internal/agents/me";
    else if (
      (method === "PUT" || method === "PATCH") &&
      rest === "/webhook"
    ) {
      // alias: PUT/PATCH /webhook → PATCH agents/me with {webhook_url}
      internal = "/internal/agents/me";
    } else if (method === "POST" && rest === "/messages") internal = "/internal/messages";
    else if (method === "GET" && rest === "/messages") internal = "/internal/messages";
    else if (method === "GET" && rest === "/stream") internal = "/internal/stream";
    else if (method === "GET" && /^\/pending\/[^/]+$/.test(rest)) internal = "/internal" + rest;
    else if (method === "GET" && rest === "/pending") internal = "/internal/pending";
    else if (method === "POST" && rest === "/read") internal = "/internal/read";
    else return json({ error: "not found" }, 404);

    const internalUrl = new URL(request.url);
    internalUrl.pathname = internal;
    const res = await stub.fetch(
      new Request(internalUrl.toString(), request)
    );
    return withCors(res);
  },
} satisfies ExportedHandler<Env>;

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders())) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}
