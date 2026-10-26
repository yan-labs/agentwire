import { Room, type Env, H_AGENT, H_AGENT_NAME, H_TRUSTED_JOIN, H_TRUSTED_LEAVE } from "./room";
import { Directory, type GlobalAgent, sha256Hex, safeEqual } from "./directory";

import { readObject } from './body';
import { directory } from './d1-directory';
import { limits, metric } from './settings';
import { mcp } from './mcp';
import { getBudget, budgetError } from './budget';
import { openapi } from './openapi';
import { BudgetController } from './budget-controller';
export { Room, Directory, BudgetController };

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
<title>Agents Hot</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; max-width: 720px; margin: 3rem auto; padding: 0 1.25rem; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
  pre { background: color-mix(in oklab, Canvas 85%, CanvasText 15%); padding: 1rem; overflow: auto; border-radius: 8px; }
  h1 { font-size: 1.6rem; margin: 0 0 .4rem; }
  .tag { opacity: .7; font-size: .9rem; }
  a { color: inherit; }
</style>
<h1>Agents Hot</h1>
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

const handler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method.toUpperCase();
    if(url.hostname==='www.agents.hot') return Response.redirect(`https://agents.hot${pathname}${url.search}`,301);
    if(!pathname.startsWith('/internal/billing-')&&(/^\/(v1(?:\/|$)|mcp$|openapi\.json$|pending(?:\/|$)|health$)/.test(pathname)||url.hostname.endsWith('.workers.dev'))) {
      const state=await getBudget(env);
      if(state.level>=4&&!await protectedRequest(request,env)) return withCors(budgetError(state,method,pathname)!);
    }
    if(pathname==='/openapi.json' && method==='GET') return json(openapi(url.origin));
    if(pathname==='/v1/public-config' && method==='GET') return json({turnstile_site_key:env.TURNSTILE_SITE_KEY||null,limits:limits(env),...limits(env)});
    if(pathname==='/internal/billing-alert'||pathname==='/internal/billing-restore') {
      if(method!=='POST') return json({error:'method not allowed'},405);
      const restore=pathname.endsWith('restore'), secret=restore?env.OPERATOR_TOKEN:env.BILLING_ALERT_SECRET;
      const supplied=restore?bearer(request):request.headers.get('cf-webhook-auth');
      if(!secret||!supplied||!await safeEqual(secret,supplied)) return json({error:'forbidden'},403);
      return json({ok:true,state:await env.BUDGET_CONTROL.getByName('global').run(restore?'restore':'stop')});
    }
    if(pathname==='/mcp') return mcp(request,env,(r)=>handler.fetch(r,env));
    if(url.hostname==='agents.hot'&&!/^\/(v1(?:\/|$)|mcp$|openapi\.json$|pending(?:\/|$)|health$)/.test(pathname)&&env.ASSETS) return env.ASSETS.fetch(request);

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (method === "GET" && pathname === "/" && url.hostname!=="api.agents.hot") {
      return landing(url.origin);
    }
    if (method === "GET" && pathname === "/health") {
      return json({ ok: true, service: "agents-hot", ts: new Date().toISOString() });
    }

    const blocked=budgetError(await getBudget(env),method==='GET'&&url.searchParams.get('ack')==='true'?'POST':method,pathname);
    if(blocked&&!await protectedRequest(request,env)) return withCors(blocked);

    // Never trust internal headers from clients.
    const clean = new Headers(request.headers);
    for (const k of [...clean.keys()]) if (k.toLowerCase().startsWith("x-aw-")) clean.delete(k);
    request = new Request(request, { headers: clean });

    const dir = directory(env);
    const token = bearer(request);
    let me: GlobalAgent | null = null;
    const resolveMe = async () => (token ? (me ??= await dir.resolve(token)) : null);

    // Export is opt-in and operator-only; hashes and webhook secrets travel only to the protected migration file.
    if(pathname==='/v1/admin/migration/export' && method==='POST') {
      if(env.MIGRATION_ENABLED!=='true'||!env.OPERATOR_TOKEN||!token||!await safeEqual(token,env.OPERATOR_TOKEN)) return json({error:'forbidden'},403);
      const body=await readJson(request), names=Array.isArray(body?.rooms)?body.rooms:[];
      const legacy=await env.DIRECTORY.getByName('global').exportData();
      const ids=new Set([...names.map(String),...(legacy.memberships as {room_id:string}[]).map(m=>m.room_id)]);
      const rooms=[];
      for(const id of ids) rooms.push(await (/^[a-f0-9]{64}$/.test(id)?env.ROOM.get(env.ROOM.idFromString(id)):env.ROOM.getByName(id)).exportData());
      return json({directory:legacy,rooms});
    }
    if(pathname==='/v1/admin/migration/prime' && method==='POST') {
      if(env.MIGRATION_ENABLED!=='true'||!env.OPERATOR_TOKEN||!token||!await safeEqual(token,env.OPERATOR_TOKEN)) return json({error:'forbidden'},403);
      const body=await readJson(request); let count=0;
      for(const id of Array.isArray(body?.rooms)?body.rooms:[]) {
        await roomStub(env,String(id)).fetch(new Request(new URL('/internal/prime',url).toString(),{method:'POST'})); count++;
      }
      return json({ok:true,rooms:count});
    }
    // Rate limit both registration entry points and anonymous room allocation.
    if(method==='POST'&&(pathname==='/v1/agents'||pathname==='/v1/agents/web'||pathname==='/v1/rooms'||/^\/v1\/rooms\/[^/]+\/agents$/.test(pathname))) {
      const ip=request.headers.get('cf-connecting-ip')||'local';
      if(!(await env.REGISTER_LIMITER.limit({key:ip})).success) return new Response(JSON.stringify({error:'registration rate limit'}),{status:429,headers:{'content-type':'application/json','retry-after':'60',...corsHeaders()}});
    }
    // Browser registration uses Origin (or the explicit /web entry point), never a client-supplied bypass flag.
    // ---- Global identity ----
    if (method === "POST" && (pathname === "/v1/agents" || pathname === '/v1/agents/web')) {
      const body = await readJson(request);
      if (!body) return json({ error: "invalid json" }, 400);
      if(request.headers.has('origin')||pathname.endsWith('/web')) {
        if(!env.TURNSTILE_SECRET) return json({error:'web registration unavailable'},503);
        const proof=typeof body.turnstile_token==='string'?body.turnstile_token:'';
        let valid=false;
        if(proof) try {
          const check=await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({secret:env.TURNSTILE_SECRET,response:proof,remoteip:request.headers.get('cf-connecting-ip')}),signal:AbortSignal.timeout(10000)});
          const result=await check.json() as {success:boolean;hostname?:string};
          valid=result.success && (!request.headers.has('origin') || result.hostname===new URL(request.headers.get('origin')!).hostname);
        } catch { valid=false; }
        if(!valid) return json({error:'invalid Turnstile token'},403);
      }
      const name = String(body.name || "").trim();
      if (!name) return json({ error: "name required" }, 400);
      if (name.length > 64) return json({ error: "name too long" }, 400);
      const hook = parseWebhook(body);
      if ("error" in hook) return json({ error: hook.error }, 400);
      const { agent, token: t } = await dir.register(name, hook.webhook_url ?? null, hook.webhook_headers ?? null);
      metric('registration');
      return json({ ...publicAgent(agent), token: t }, 201);
    }
    if (pathname === "/v1/me" || pathname === "/v1/agents/me" || pathname === "/v1/me/rooms" || pathname === "/v1/me/token") {
      const a = await resolveMe();
      if (!a) return json({ error: token ? "unauthorized" : "missing bearer token" }, 401);
      if (method === "GET" && (pathname === "/v1/me" || pathname === "/v1/agents/me")) {
        const fresh=await dir.get(a.id); if(!fresh) return json({error:'unauthorized'},401);
        return json({ ...publicAgent(fresh), rooms: await dir.rooms(a.id) });
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
      if(!res.ok) await dir.restoreInvite(decodeURIComponent(inv[1]));
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

    const publicPoll=/^\/pending\/([^/]+)\/([^/]+)$/.exec(pathname);
    if(method==='GET'&&publicPoll) return cachedPending(env,decodeURIComponent(publicPoll[1]),decodeURIComponent(publicPoll[2]),null,null,request.headers.get('cf-connecting-ip'));
    // /v1/rooms/:id/...
    const m = /^\/v1\/rooms\/([^/]+)(\/.*)?$/.exec(pathname);
    if (!m) {
      return json({ error: "not found" }, 404);
    }
    const roomId = decodeURIComponent(m[1]);
    const rest = m[2] || "";
    const stub = roomStub(env, roomId);
    if(method==='GET' && (rest==='/pending'||/^\/pending\/[^/]+$/.test(rest))) {
      if(rest!=='/pending') return cachedPending(env,roomId,decodeURIComponent(rest.slice(9)),null,null,request.headers.get('cf-connecting-ip'));
      return cachedPending(env,roomId,null,token,await resolveMe(),request.headers.get('cf-connecting-ip'));
    }

    if(!await dir.roomExists(roomId)) return json({error:'room not found'},404);
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
    } else if (method === "POST" && rest === "/messages/batch") internal = "/internal/messages/batch";
    else if (method === "POST" && rest === "/messages") internal = "/internal/messages";
    else if (method === "GET" && rest === "/messages") internal = "/internal/messages";
    else if (method === "GET" && rest === "/ws") internal = "/internal/ws";
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
    else if ((method === "POST" || method === "GET") && rest === "/invites" || method === "DELETE" && /^\/invites\/[^/]+$/.test(rest)) {
      // authorize against the room, then mint the code in the Directory
      if (token && url.searchParams.get("token") === null) await resolveMe();
      const h = new Headers(request.headers);
      if (me) h.set(H_AGENT, (me as GlobalAgent).id);
      const authRes = await stub.fetch(new Request(new URL("/internal/authz", request.url).toString(), { method: "GET", headers: h }));
      if (!authRes.ok) return withCors(authRes);
      const auth = (await authRes.json()) as { agent_id: string | null };
      if(method==='GET') return json({invites:await dir.listInvites(roomId)});
      if(method==='DELETE') { await dir.revokeInvite(roomId,decodeURIComponent(rest.slice(9))); return json({ok:true}); }
      const body = (await readJson(request)) || {};
      const uses = Math.min(Math.max(parseInt(String(body.uses ?? 1), 10) || 1, 1), 100);
      const ttl = Math.min(Math.max(parseInt(String(body.ttl_seconds ?? 86400), 10) || 86400, 60), 30 * 86400);
      const invite = await dir.createInvite(roomId, auth.agent_id, uses, ttl);
      return json({ ...invite, accept_url: `${url.origin}/v1/invites/${invite.code}/accept` }, 201);
    } else if (method === "POST" && rest === "/migrate") {
      if(env.MIGRATION_ENABLED!=='true'||!env.OPERATOR_TOKEN||!token||!await safeEqual(token,env.OPERATOR_TOKEN)) return json({error:'forbidden'},403);
      internal = "/internal/migrate";
    }
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
export default {
  async scheduled(_event:ScheduledController,env:Env,ctx:ExecutionContext) {ctx.waitUntil(env.BUDGET_CONTROL.getByName('global').run('sample').then(()=>undefined));},
  async fetch(request:Request,env:Env) {
    let res:Response;
    try {res=await handler.fetch(request,env);}
    catch(e) {res=e instanceof Error&&/^(room membership|global identity|global room|room invite) limit$/.test(e.message)?json({error:e.message},409):json({error:'internal error'},500);}
    metric('request',{method:request.method,status:res.status,error:res.status>=500});
    return res;
  }
} satisfies ExportedHandler<Env>;

function withCors(res: Response): Response {
  if(res.status===101) return res;
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders())) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}

function bearer(req: Request): string | null {
  const h = req.headers.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

const readJson=readObject;

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
      if(raw.length>2048) return {error:'webhook_url too long'};
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
      if(JSON.stringify(h).length>8192) return {error:'webhook_headers too large'};
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
    webhook_paused: Boolean(a.webhook_paused)||JSON.parse(a.paused_rooms||'[]').length>0,
    paused_room_webhooks: JSON.parse(a.paused_rooms||'[]'),
    webhook_failures: a.webhook_failures ?? 0,
    created_at: a.created_at,
  };
}

/** Remove an identity from every room (handing off ownership), then delete it and all its tokens. */
async function deleteIdentity(env: Env, id: string, base: string) {
  const dir = directory(env);
  const rooms = await dir.rooms(id);
  const left = [];
  for (const r of rooms) {
    const res = await env.ROOM.getByName(r.room_id).fetch(
      new Request(new URL(`/internal/members/${encodeURIComponent(id)}`, base).toString(), { method: "DELETE", headers: { [H_TRUSTED_LEAVE]: "1" } })
    );
    if(!res.ok&&res.status!==404) throw new Error('room cleanup failed');
    const j = (await res.json().catch(() => ({}))) as { new_owner?: string | null };
    left.push({ room_id: r.room_id, status: res.status, new_owner: j.new_owner ?? null });
  }
  await dir.deleteAgent(id);
  return { ok: true, deleted: id, rooms_left: left };
}

async function cachedPending(env:Env,room:string,id:string|null,token?:string|null,me?:GlobalAgent|null,ip?:string|null) {
  const headers={'content-type':'application/json',...corsHeaders(),'cache-control':`private, max-age=${limits(env).min_poll_seconds}`,'retry-after':String(limits(env).min_poll_seconds),'x-poll-min-interval':String(limits(env).min_poll_seconds)};
  if(!(await env.POLL_LIMITER.limit({key:`${ip||'local'}:${room}:${id||await sha256Hex(token||'')}`})).success) return new Response(JSON.stringify({error:'poll at most once per 60 seconds'}),{status:429,headers});
  const publicKey=id?new Request(`https://agents.hot/cache-pending/${encodeURIComponent(room)}/${encodeURIComponent(id)}`):null;
  if(publicKey) {const hit=await caches.default.match(publicKey);if(hit)return hit;}
  const snapshot=await env.PENDING.get<{members:Record<string,{has_new:boolean;latest_id:string|null}>;tokens:Record<string,string>}>(`room:${room}`,'json');
  if(!id) {
    if(!token) return new Response(JSON.stringify({error:'missing bearer token'}),{status:401,headers});
    id=me?.id??snapshot?.tokens[await sha256Hex(token)]??null;
    if(id&&!me&&await directory(env).get(id)) id=null;
    if(!id) return new Response(JSON.stringify({error:'unauthorized'}),{status:401,headers});
    const data=snapshot?.members[id];
    return new Response(JSON.stringify(data??{error:'unauthorized'}),{status:data?200:401,headers});
  }
  const key=publicKey!;
  const object=await env.UNREAD.get(`${room}/${id}.json`);
  const state=object?await object.json<{has_new:boolean}>():null;
  const data=state&&snapshot?.members[id];
  const response=new Response(JSON.stringify(data?{has_new:data.has_new,latest_id:data.latest_id}:{error:'not found'}),{status:data?200:404,headers});
  if(data) {const copy=new Response(response.clone().body,{headers:{...headers,'cache-control':'public, max-age=60'}});await caches.default.put(key,copy);}
  return response;
}

// Emergency access is restricted to pinned members, supported operations and the protected room.
async function protectedRequest(request:Request,env:Env) {
 const url=new URL(request.url), path=url.pathname, method=request.method;
 if(!url.hostname.endsWith('.workers.dev')) return false;
 const room='room_cdc26cdd5dab08d7f63427a8';
 const snapshot=await env.PENDING.get<{protected_members?:string[]}>('room:'+room,'json');
 const ids=snapshot?.protected_members||[];
 const match=new RegExp('^/v1/rooms/'+room+'(?:/(.*))?$').exec(path);
 if(match&&method==='GET'&&match[1]?.startsWith('pending/')) return ids.includes(decodeURIComponent(match[1].slice(8)));
 const token=bearer(request)||url.searchParams.get('token');
 if(!token) return false;
 const me=await directory(env).resolve(token);
 if(!me||!ids.includes(me.id)) return false;
 if(['/v1/me','/v1/agents/me','/v1/me/rooms','/v1/me/token'].includes(path)) return ['GET','PATCH','POST'].includes(method);
 return !!match&&((method==='GET'&&['','messages','pending','ws','stream'].includes(match[1]||''))||(method==='POST'&&['messages','read'].includes(match[1]||''))||(['PATCH','PUT'].includes(method)&&['agents/me','webhook'].includes(match[1]||'')));
}
