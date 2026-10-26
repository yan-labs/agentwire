// LOCAL-ONLY shim that fills in the backend endpoints that do not exist on `main` yet, so the console can be
// exercised end to end. Each route first goes to the real local backend; the shim answers only if the backend
// says 404 (i.e. it has not implemented the endpoint). Planned shapes (ALIGN with the backend branch):
//   GET  /v1/public-config                    -> { turnstile_site_key, limits, min_poll_seconds }
//   GET  /v1/rooms/:id/invites                -> { invites: [{ id, uses_left, expires_at, created_at, created_by }] }
//   DELETE /v1/rooms/:id/invites/:code        -> { ok: true }   (':code' = the code or the listed id)
// Revocation is emulated by refusing POST /v1/invites/:code/accept for revoked codes.
// fetch() already decoded the body, so drop the encoding/length headers before replying
export const passHeaders = (h) => { const o = Object.fromEntries(h); for (const k of ['content-encoding', 'content-length', 'transfer-encoding', 'connection']) delete o[k]; return o; };
const invites = new Map(); // room_id -> [{ code, id, uses_left, expires_at, created_at, created_by }]
const revoked = new Set();

const json = (res, status, body, extra = {}) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', ...extra }); res.end(JSON.stringify(body)); return true; };
const readBody = async (req) => { const c = []; for await (const x of req) c.push(x); return c.length ? Buffer.concat(c) : undefined; };

async function backend(BACKEND, method, path, req, body) {
  const headers = {};
  if (req.headers.authorization) headers.authorization = req.headers.authorization;
  if (body) headers['content-type'] = 'application/json';
  return fetch(BACKEND + path, { method, headers, body });
}

async function managerOf(BACKEND, req, roomId) {
  const me = await backend(BACKEND, 'GET', '/v1/me', req);
  if (!me.ok) return { fail: me };
  const meJson = await me.json();
  const mem = await backend(BACKEND, 'GET', `/v1/rooms/${roomId}/members`, req);
  if (!mem.ok) return { fail: mem };
  const m = (await mem.json()).members.find((x) => x.agent_id === meJson.agent_id);
  return { agent: meJson.agent_id, role: m?.role ?? null, manager: m?.role === 'owner' || m?.role === 'admin' };
}

export async function shim(req, res, url, BACKEND) {
  if (process.env.AW_SHIM === 'off') return false;
  const p = url.pathname;
  let m;

  if (req.method === 'GET' && p === '/v1/public-config') {
    const r = await backend(BACKEND, 'GET', p, req);
    if (r.status !== 404) { res.writeHead(r.status, passHeaders(r.headers)); res.end(Buffer.from(await r.arrayBuffer())); return true; }
    return json(res, 200, {
      turnstile_site_key: process.env.SHIM_TURNSTILE_KEY || null,
      limits: { rooms_per_identity: 50, members_per_room: 20, message_chars: 32000, keep_messages: 50, idle_delete_days: 30, idle_warn_days: 7 },
      min_poll_seconds: 60,
      _shim: true,
    });
  }

  // record invites as they are created so the list can be served
  if (req.method === 'POST' && (m = /^\/v1\/rooms\/([^/]+)\/invites$/.exec(p))) {
    const probe = await backend(BACKEND, 'GET', p, req);
    if (probe.status !== 404) return false; // backend implements invites listing: no shim, let it proxy normally
    const body = await readBody(req);
    const r = await fetch(BACKEND + p, { method: 'POST', headers: { authorization: req.headers.authorization ?? '', 'content-type': 'application/json' }, body });
    const text = await r.text();
    if (r.status === 201) {
      const inv = JSON.parse(text);
      const who = await managerOf(BACKEND, req, m[1]);
      const list = invites.get(m[1]) ?? [];
      list.push({ code: inv.code, id: inv.code.slice(0, 12), uses_left: inv.uses, expires_at: inv.expires_at, created_at: new Date().toISOString(), created_by: who.agent ?? null });
      invites.set(m[1], list);
    }
    res.writeHead(r.status, passHeaders(r.headers));
    res.end(text);
    return true;
  }

  if (req.method === 'GET' && (m = /^\/v1\/rooms\/([^/]+)\/invites$/.exec(p))) {
    const r = await backend(BACKEND, 'GET', p, req);
    if (r.status !== 404) { res.writeHead(r.status, passHeaders(r.headers)); res.end(Buffer.from(await r.arrayBuffer())); return true; }
    const who = await managerOf(BACKEND, req, m[1]);
    if (who.fail) { res.writeHead(who.fail.status, { 'content-type': 'application/json' }); res.end(Buffer.from(await who.fail.arrayBuffer())); return true; }
    if (!who.manager) return json(res, 403, { error: 'only the room owner or an admin can do this' });
    const now = new Date().toISOString();
    const list = (invites.get(m[1]) ?? []).filter((i) => i.expires_at > now && !revoked.has(i.code));
    return json(res, 200, { invites: list.map(({ code, ...rest }) => rest) });
  }

  if (req.method === 'DELETE' && (m = /^\/v1\/rooms\/([^/]+)\/invites\/([^/]+)$/.exec(p))) {
    const who = await managerOf(BACKEND, req, m[1]);
    if (who.fail) { res.writeHead(who.fail.status, { 'content-type': 'application/json' }); res.end(Buffer.from(await who.fail.arrayBuffer())); return true; }
    if (!who.manager) return json(res, 403, { error: 'only the room owner or an admin can do this' });
    const key = decodeURIComponent(m[2]);
    const hit = (invites.get(m[1]) ?? []).find((i) => i.code === key || i.id === key);
    if (!hit) return json(res, 404, { error: 'not found' });
    revoked.add(hit.code);
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && (m = /^\/v1\/invites\/([^/]+)\/accept$/.exec(p)) && revoked.has(decodeURIComponent(m[1]))) {
    return json(res, 404, { error: 'invite invalid or expired' });
  }
  return false;
}
