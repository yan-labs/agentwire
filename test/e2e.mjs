// End-to-end test: node test/e2e.mjs  (BASE defaults to local `wrangler dev`)
// HOOK_URL: a URL that records POSTs; HOOK_CHECK(): returns received bodies. Locally we start our own receiver.
// Never prints tokens.
import http from "node:http";
const BASE = process.env.BASE || "http://127.0.0.1:8787";
let received = [];
let HOOK_URL = process.env.HOOK_URL;
let server;
if (!HOOK_URL && !process.env.WEBHOOK_SITE) {
  server = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { received.push({ headers: req.headers, body: JSON.parse(b) }); res.end("ok"); }); }).listen(8799);
  HOOK_URL = "http://127.0.0.1:8799/hook";
}
let fails = 0;
const ok = (c, msg) => { console.log(`${c ? "PASS" : "FAIL"} ${msg}`); if (!c) fails++; };
async function call(method, path, token, body) {
  const r = await fetch(BASE + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, j };
}
// Remote mode: WEBHOOK_SITE=1 creates a throwaway webhook.site inbox and reads deliveries from it.
let siteToken = null;
if (process.env.WEBHOOK_SITE) {
  const t = await (await fetch("https://webhook.site/token", { method: "POST" })).json();
  siteToken = t.uuid; HOOK_URL = `https://webhook.site/${siteToken}`;
}
async function syncReceived() {
  if (!siteToken) return;
  const r = await (await fetch(`https://webhook.site/token/${siteToken}/requests?sorting=newest&per_page=50`)).json();
  received = r.data.map((x) => ({ headers: Object.fromEntries(Object.entries(x.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])), body: JSON.parse(x.content) }));
}
const sleep = async (ms) => { await new Promise((r) => setTimeout(r, ms)); await syncReceived(); };

// legacy flow still works
const room = await call("POST", "/v1/rooms");
ok(room.status === 200 && room.j.room_id, "legacy: create room");
const R = room.j.room_id, ADMIN = room.j.admin_token;
const L1 = await call("POST", `/v1/rooms/${R}/agents`, ADMIN, { name: "legacy-a", webhook_url: HOOK_URL });
const L2 = await call("POST", `/v1/rooms/${R}/agents`, ADMIN, { name: "legacy-b" });
ok(L1.j?.token && L2.j?.token, "legacy: register per-room agents");
let r = await call("POST", `/v1/rooms/${R}/messages`, L2.j.token, { text: "hi legacy OVER" });
ok(r.status === 201, "legacy: post message");
await sleep(2500);
ok(received.some((x) => x.body.message?.text === "hi legacy OVER"), "legacy: webhook delivered");
ok((await call("GET", `/v1/rooms/${R}/pending/${L1.j.agent_id}`)).j?.has_new === true, "legacy: tokenless pending");

// migrate legacy members to global identities
r = await call("POST", `/v1/rooms/${R}/migrate`, ADMIN);
ok(r.status === 200 && r.j.agents.length === 2, "migrate: imported members");
r = await call("POST", `/v1/rooms/${R}/migrate`, ADMIN);
ok(r.status === 200 && r.j.agents.every((a) => !a.created), "migrate: idempotent");
r = await call("GET", "/v1/me/rooms", L1.j.token);
ok(r.status === 200 && r.j.rooms.some((x) => x.room_id === R), "migrate: legacy token works as global token (/v1/me/rooms)");
r = await call("POST", `/v1/rooms/${R}/messages`, L1.j.token, { text: "still here" });
ok(r.status === 201, "migrate: legacy token can still post");

// global identities
const A = await call("POST", "/v1/agents", null, { name: "alpha" });
const B = await call("POST", "/v1/agents", null, { name: "beta", webhook_url: HOOK_URL });
ok(A.status === 201 && A.j.agent_id && A.j.token, "global: register alpha");
ok(B.status === 201 && B.j.has_webhook, "global: register beta with webhook");
r = await call("GET", "/v1/me", A.j.token);
ok(r.j?.agent_id === A.j.agent_id && !("token" in r.j), "global: /v1/me");

// alpha creates a room as owner
const G = await call("POST", "/v1/rooms", A.j.token);
ok(G.status === 200 && G.j.owner_id === A.j.agent_id, "rooms: created with owner");
const GR = G.j.room_id;
r = await call("POST", `/v1/rooms/${GR}/messages`, B.j.token, { text: "sneak" });
ok(r.status === 401, "rooms: non-member cannot post");
r = await call("POST", `/v1/rooms/${GR}/members`, B.j.token, { agent_id: B.j.agent_id });
ok(r.status === 403, "members: non-member cannot add self");
r = await call("POST", `/v1/rooms/${GR}/members`, A.j.token, { agent_id: "agent_nope" });
ok(r.status === 404, "members: unknown agent_id rejected");
r = await call("POST", `/v1/rooms/${GR}/members`, A.j.token, { agent_id: B.j.agent_id });
ok(r.status === 201 && r.j.name === "beta", "members: owner adds beta by agent_id");
r = await call("GET", "/v1/me/rooms", B.j.token);
ok(r.j.rooms.some((x) => x.room_id === GR), "me/rooms: beta sees room");
// beta is in two rooms with one token
r = await call("POST", `/v1/rooms/${R}/members`, ADMIN, { agent_id: B.j.agent_id });
ok(r.status === 201, "members: admin adds beta to legacy room too");
r = await call("GET", "/v1/me/rooms", B.j.token);
ok(r.j.rooms.length === 2, "me/rooms: beta in 2 rooms");
received = []; const sinceSite = siteToken;
r = await call("POST", `/v1/rooms/${GR}/messages`, A.j.token, { text: "hello beta OVER" });
ok(r.status === 201, "messages: alpha posts in owned room");
await sleep(2500);
const hit = received.find((x) => x.body.message?.text === "hello beta OVER");
ok(hit && hit.body.to_agent === B.j.agent_id && hit.headers["x-agentwire-room"] === GR, "webhook: identity-level webhook fires");
r = await call("GET", `/v1/rooms/${GR}/messages`, B.j.token);
ok(r.j?.messages?.some((m) => m.text === "hello beta OVER"), "messages: beta reads");
r = await call("POST", `/v1/rooms/${R}/messages`, B.j.token, { text: "beta in legacy room" });
ok(r.status === 201, "messages: beta posts in second room with same token");
r = await call("GET", `/v1/rooms/${GR}/pending`, B.j.token);
ok(r.j?.has_new === true, "pending: authed pending for global member");
ok((await call("GET", `/v1/rooms/${GR}/pending/${B.j.agent_id}`)).j?.has_new === true, "pending: tokenless pending for global member");
// spoofed internal header ignored
const sp = await fetch(`${BASE}/v1/rooms/${GR}/messages`, { method: "POST", headers: { authorization: "Bearer junk", "x-aw-agent-id": A.j.agent_id, "content-type": "application/json" }, body: JSON.stringify({ text: "spoof" }) });
ok(sp.status === 401, "security: spoofed x-aw-agent-id rejected");

// invites
const C = await call("POST", "/v1/agents", null, { name: "gamma" });
const iv = await call("POST", `/v1/rooms/${GR}/invites`, B.j.token, { uses: 1 });
ok(iv.status === 201 && iv.j.code, "invites: member creates invite");
r = await call("POST", `/v1/invites/${iv.j.code}/accept`, C.j.token);
ok(r.status === 201 && r.j.agent_id === C.j.agent_id, "invites: gamma joins via code");
r = await call("POST", `/v1/invites/${iv.j.code}/accept`, C.j.token);
ok(r.status === 404, "invites: single-use code consumed");

// removal
r = await call("DELETE", `/v1/rooms/${GR}/members/${A.j.agent_id}`, B.j.token);
ok(r.status === 403, "remove: plain member cannot remove owner");
r = await call("DELETE", `/v1/rooms/${GR}/members/${B.j.agent_id}`, A.j.token);
ok(r.status === 200, "remove: owner removes beta");
r = await call("POST", `/v1/rooms/${GR}/messages`, B.j.token, { text: "after removal" });
ok(r.status === 401, "remove: beta can no longer post");
r = await call("GET", "/v1/me/rooms", B.j.token);
ok(!r.j.rooms.some((x) => x.room_id === GR), "remove: room gone from beta's list");
r = await call("DELETE", `/v1/rooms/${GR}/members/${C.j.agent_id}`, C.j.token);
ok(r.status === 200, "remove: member can leave");

// cleanup
r = await call("DELETE", `/v1/rooms/${GR}`, A.j.token);
ok(r.status === 200, "cleanup: owner deletes room");
r = await call("DELETE", `/v1/rooms/${R}`, ADMIN);
ok(r.status === 200, "cleanup: admin deletes legacy room");
r = await call("GET", "/v1/me/rooms", B.j.token);
ok(r.j.rooms.length === 0, "cleanup: memberships dropped");
console.log(fails ? `${fails} FAILED` : "ALL PASS");
server?.close();
process.exit(fails ? 1 : 0);
