import { DurableObject } from "cloudflare:workers";

import type { Directory, GlobalAgent } from "./directory";
import { directory } from "./d1-directory";
import { readObject } from './body';
import { getBudget } from './budget';
import { limits, numberSetting, metric } from "./settings";

export interface Env {
  ROOM: DurableObjectNamespace<Room>;
  DIRECTORY: DurableObjectNamespace<Directory>;
  DB: D1Database;
  UNREAD: R2Bucket;
  BUDGET_ENABLED?: string;
  BUDGET_LIMITS?: string;
  BUDGET_THRESHOLDS?: string;
  CF_ANALYTICS_TOKEN?: string;
  CF_GUARD_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  CF_ZONE_ID?: string;
  CF_SCRIPT_NAME?: string;
  USAGE_QUERY?: string;
  WAF_RULESET_ID?: string;
  WAF_RULE_ID?: string;
  WAF_API_EXPRESSION?: string;
  ALLOW_WORKERS_DEV?: string;
  MAX_IDENTITIES?: string;
  MAX_GLOBAL_ROOMS?: string;

  PENDING: KVNamespace;
  ASSETS?: Fetcher;
  REGISTER_LIMITER: RateLimit;
  MESSAGE_LIMITER: RateLimit;
  ROOM_LIMITER: RateLimit;
  POLL_LIMITER: RateLimit;
  OPERATOR_TOKEN?: string;
  TURNSTILE_SECRET?: string;
  TURNSTILE_SITE_KEY?: string;
  MAX_ROOMS?: string;
  MAX_MEMBERS?: string;
  MAX_MESSAGES?: string;
  MIN_POLL_SECONDS?: string;
  PENDING_FLUSH_SECONDS?: string;
  SSE_MAX_SECONDS?: string;
  IDLE_DAYS?: string;
  WARNING_DAYS?: string;
  EXEMPT_ROOMS?: string;
  WEBHOOK_MAX_FAILURES?: string;
  WEBHOOK_RETRY_SECONDS?: string;
  MIGRATION_ENABLED?: string;

}

/** Internal headers set only by the Worker after verifying a global token (stripped from client requests). */
export const H_AGENT = "x-aw-agent-id";
export const H_AGENT_NAME = "x-aw-agent-name";
export const H_TRUSTED_JOIN = "x-aw-trusted-join";
export const H_TRUSTED_LEAVE = "x-aw-trusted-leave";

export type Role = "owner" | "admin" | "member";

type Agent = {
  id: string;
  name: string;
  token_hash: string;
  webhook_url: string | null;
  webhook_headers: string | null;
  last_read: string | null;
  role: string | null;
  created_at: string;
};

type Message = {
  id: string;
  room_id: string;
  from: string;
  to: string | null;
  text: string;
  meta: Record<string, unknown> | null;
  created_at: string;
};

type RoomMeta = {
  room_id: string;
  admin_token_hash: string;
  owner_id: string | null;
  created_at: string;
};



function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
    },
  });
}

function err(message: string, status: number): Response {
  return json({ error: message }, status);
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomId(prefix: string): string {
  return `${prefix}_${randomToken(12)}`;
}

function bearer(req: Request): string | null {
  const h = req.headers.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

export class Room extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => this.initialize());
  }

  private initialize() {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS meta (
          room_id TEXT PRIMARY KEY,
          admin_token_hash TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS agents (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          token_hash TEXT NOT NULL UNIQUE,
          webhook_url TEXT,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          room_id TEXT NOT NULL,
          from_agent TEXT NOT NULL,
          to_agent TEXT,
          text TEXT NOT NULL,
          meta TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
        CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
        CREATE TABLE IF NOT EXISTS webhook_jobs (
          id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, payload TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL, version TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_hooks_due ON webhook_jobs(due);
      `);
      for (const col of ["webhook_headers TEXT", "last_read TEXT", "kind TEXT", "role TEXT"]) {
        try { this.ctx.storage.sql.exec(`ALTER TABLE agents ADD COLUMN ${col}`); } catch {}
      }
      try { this.ctx.storage.sql.exec(`ALTER TABLE meta ADD COLUMN owner_id TEXT`); } catch {}
  }

  private deleted=false;
  private getMeta(): RoomMeta | null {
    if(this.deleted) return null;
    const rows = this.ctx.storage.sql
      .exec<RoomMeta>("SELECT room_id, admin_token_hash, owner_id, created_at FROM meta LIMIT 1")
      .toArray();
    return rows[0] ?? null;
  }

  private listAgents(): Agent[] {
    return this.ctx.storage.sql
      .exec<Agent>(
        "SELECT id, name, token_hash, webhook_url, webhook_headers, last_read, role, created_at FROM agents ORDER BY created_at ASC"
      )
      .toArray()
      .map((a) => ({
        ...a,
        webhook_url: a.webhook_url ?? null,
      }));
  }

  private async findAgentByToken(token: string): Promise<Agent | null> {
    const hash = await sha256Hex(token);
    const rows = this.ctx.storage.sql
      .exec<Agent>(
        "SELECT id, name, token_hash, webhook_url, webhook_headers, last_read, role, created_at FROM agents WHERE token_hash = ?",
        hash
      )
      .toArray();
    const a = rows[0];
    if (!a) return null;
    if (await this.dir().get(a.id) && (await this.dir().resolve(token))?.id !== a.id) return null;
    return { ...a, webhook_url: a.webhook_url ?? null };
  }

  /** Caller = legacy per-room token, or a global identity the Worker verified (H_AGENT) that is a member here. */
  private async findCaller(request: Request, token: string): Promise<Agent | null> {
    const gid = request.headers.get(H_AGENT);
    if (gid) {
      const a = this.listAgents().find((x) => x.id === gid);
      if (a) return a;
    }
    return this.findAgentByToken(token);
  }

  private dir() {
    return directory(this.env);
  }

  private roleOf(a: Agent, meta: RoomMeta): Role {
    if (meta.owner_id && a.id === meta.owner_id) return "owner";
    return a.role === "admin" ? "admin" : "member";
  }

  /** admin_token counts as owner-level authority. */
  private async callerRole(request: Request): Promise<{ admin: boolean; agent: Agent | null; globalId: string | null; role: Role | null; manager: boolean; ownerLevel: boolean }> {
    const token = bearer(request);
    const globalId = request.headers.get(H_AGENT);
    const meta = this.getMeta();
    if (!token || !meta) return { admin: false, agent: null, globalId, role: null, manager: false, ownerLevel: false };
    const admin = await this.isAdmin(token);
    const agent = await this.findCaller(request, token);
    const role = agent ? this.roleOf(agent, meta) : null;
    const ownerLevel = admin || role === "owner";
    return { admin, agent, globalId, role, manager: ownerLevel || role === "admin", ownerLevel };
  }

  private memberList(meta: RoomMeta) {
    return this.listAgents().map((a) => ({
      id: a.id,
      agent_id: a.id,
      name: a.name,
      role: this.roleOf(a, meta),
      kind: a.token_hash.startsWith("global:") ? "global" : "legacy",
      has_room_webhook: Boolean(a.webhook_url),
      has_webhook: Boolean(a.webhook_url),
      has_webhook_headers: Boolean(a.webhook_headers),
      created_at: a.created_at,
    }));
  }

  private async listMembers(request: Request): Promise<Response> {
    const meta = this.getMeta();
    if (!meta) return err("room not found", 404);
    const { admin, agent } = await this.callerRole(request);
    if (!admin && !agent) return err("unauthorized", 401);
    return json({ room_id: meta.room_id, owner_id: meta.owner_id ?? null, members: this.memberList(meta) });
  }

  private async addMember(request: Request): Promise<Response> {
    const meta = this.getMeta();
    if (!meta) return err("room not found", 404);
    const trusted = request.headers.get(H_TRUSTED_JOIN) === "1";
    const { manager } = await this.callerRole(request);
    if (!trusted && !manager) return err("only the room owner or an admin can add members", 403);
    let body: { agent_id?: string; name?: string } = {};
    try { body = (await readObject(request)) as typeof body; } catch { return err("invalid json", 400); }
    if(!body) return err('invalid json',400);
    const id = String(body.agent_id || "");
    const hdrName = request.headers.get(H_AGENT_NAME);
    const name = String((hdrName ? decodeURIComponent(hdrName) : body.name) || id).slice(0, 64);
    if (!id) return err("agent_id required", 400);
    const existing = this.listAgents().find((a) => a.id === id);
    if (!existing) {
      if (this.listAgents().length >= limits(this.env).max_members) return err("room member limit", 409);
      await this.dir().addMembership(id, meta.room_id);
      this.ctx.storage.sql.exec(
        "INSERT INTO agents (id, name, token_hash, webhook_url, webhook_headers, created_at, kind, role) VALUES (?, ?, ?, NULL, NULL, ?, 'global', 'member')",
        id, name, `global:${id}`, new Date().toISOString()
      );
    }
    await this.queuePending();
    return json({ room_id: meta.room_id, agent_id: id, name: existing ? existing.name : name, role: existing ? this.roleOf(existing, meta) : "member", already_member: Boolean(existing) }, existing ? 200 : 201);
  }

  private dropMember(meta: RoomMeta, id: string) {
    this.ctx.storage.sql.exec("DELETE FROM agents WHERE id = ?", id);
    for (const ws of this.ctx.getWebSockets(id)) ws.close(1008, 'membership ended');
    this.ctx.storage.sql.exec('DELETE FROM webhook_jobs WHERE agent_id=?', id);
    this.pruneRead();
    if (this.kvGet("floor") === id) this.kvSet("floor", null);
  }

  private async removeMember(request: Request, id: string): Promise<Response> {
    const meta = this.getMeta();
    if (!meta) return err("room not found", 404);
    const target = this.listAgents().find((a) => a.id === id);
    if (!target) return err("not a member", 404);
    const targetRole = this.roleOf(target, meta);
    // Identity deletion (Worker-verified): force removal; hand ownership to an admin, else the oldest member.
    if (request.headers.get(H_TRUSTED_LEAVE) === "1") {
      this.dropMember(meta, id);
      let new_owner: string | null = null;
      if (targetRole === "owner") {
        const rest = this.listAgents();
        const next = rest.find((a) => a.role === "admin") ?? rest[0];
        new_owner = next ? next.id : null;
        this.ctx.storage.sql.exec("UPDATE meta SET owner_id = ?", new_owner);
        if (next) this.ctx.storage.sql.exec("UPDATE agents SET role = 'member' WHERE id = ?", next.id);
      }
      await this.dir().removeMembership(id, meta.room_id);
      await this.queuePending();
      return json({ ok: true, room_id: meta.room_id, removed: id, new_owner });
    }
    const { agent, role, ownerLevel } = await this.callerRole(request);
    const isSelf = Boolean(agent && agent.id === id);
    if (targetRole === "owner") return err("the owner cannot be removed or leave; transfer ownership first (POST /v1/rooms/:id/owner)", 403);
    const allowed = isSelf || ownerLevel || (role === "admin" && targetRole === "member");
    if (!allowed) return err(role === "admin" ? "admins can only remove regular members" : "only the room owner or an admin can remove members", 403);
    this.dropMember(meta, id);
    await this.dir().removeMembership(id, meta.room_id);
    await this.queuePending();
    return json({ ok: true, room_id: meta.room_id, removed: id });
  }

  private async setAdmin(request: Request, id: string, on: boolean): Promise<Response> {
    const meta = this.getMeta();
    if (!meta) return err("room not found", 404);
    const { ownerLevel } = await this.callerRole(request);
    if (!ownerLevel) return err("only the room owner can change admins", 403);
    const target = this.listAgents().find((a) => a.id === id);
    if (!target) return err("not a member", 404);
    if (this.roleOf(target, meta) === "owner") return err("the owner is already above admin", 400);
    this.ctx.storage.sql.exec("UPDATE agents SET role = ? WHERE id = ?", on ? "admin" : "member", id);
    return json({ ok: true, room_id: meta.room_id, agent_id: id, role: on ? "admin" : "member" });
  }

  private async transferOwner(request: Request): Promise<Response> {
    const meta = this.getMeta();
    if (!meta) return err("room not found", 404);
    const { ownerLevel } = await this.callerRole(request);
    if (!ownerLevel) return err("only the room owner (or admin_token) can transfer ownership", 403);
    let body: { agent_id?: string } = {};
    try { body = (await readObject(request)) as typeof body; } catch { return err("invalid json", 400); }
    if(!body) return err('invalid json',400);
    const target = this.listAgents().find((a) => a.id === body.agent_id);
    if (!target) return err("new owner must be a member of the room", 400);
    const prev = meta.owner_id ?? null;
    this.ctx.storage.sql.exec("UPDATE meta SET owner_id = ?", target.id);
    this.ctx.storage.sql.exec("UPDATE agents SET role = 'member' WHERE id = ?", target.id);
    if (prev && prev !== target.id) this.ctx.storage.sql.exec("UPDATE agents SET role = 'admin' WHERE id = ?", prev);
    return json({ ok: true, room_id: meta.room_id, owner_id: target.id, previous_owner: prev, previous_owner_role: prev && prev !== target.id ? "admin" : null });
  }

  /** Who may manage this room (invites): admin or any member. */
  private async authz(request: Request): Promise<Response> {
    const meta = this.getMeta();
    if (!meta) return err("room not found", 404);
    const { agent, manager } = await this.callerRole(request);
    if (!manager) return err("only the room owner or an admin can do this", 403);
    const admin = !agent;
    return json({ ok: true, room_id: meta.room_id, agent_id: agent ? agent.id : null, admin });
  }

  /** Admin-only, idempotent: register every member of this room as a global identity (same id + same token). */
  private async migrate(request: Request): Promise<Response> {
    const meta = this.getMeta();
    if (!meta) return err("room not found", 404);
    const { admin } = await this.callerRole(request);
    if (!admin) return err("admin token required", 403);
    const out = [];
    for (const a of this.listAgents()) {
      if (a.token_hash.startsWith("global:")) { await this.dir().addMembership(a.id, meta.room_id); out.push({ id: a.id, name: a.name, created: false }); continue; }
      // Global webhook defaults to the room webhook; the room row keeps it as a per-room override.
      const r = await this.dir().importAgent({ id: a.id, name: a.name, token_hash: a.token_hash, webhook_url: a.webhook_url, webhook_headers: a.webhook_headers, created_at: a.created_at }, meta.room_id);
      out.push({ id: a.id, name: a.name, created: r.created });
    }
    return json({ ok: true, room_id: meta.room_id, agents: out });
  }

  private async deleteRoom(request: Request): Promise<Response> {
    const meta = this.getMeta();
    if (!meta) return err("room not found", 404);
    const { ownerLevel } = await this.callerRole(request);
    if (!ownerLevel) return err("only the room owner (or admin_token) can delete the room", 403);
    await this.dir().dropRoom(meta.room_id);
    for (const [w, st] of this.streams) { clearInterval(st.timer); w.close().catch(() => undefined); }
    this.streams.clear();
    for (const ws of this.ctx.getWebSockets()) ws.close(1001, 'room deleted');
    for(const a of this.listAgents()) await this.env.UNREAD.delete(`${meta.room_id}/${a.id}.json`);
    await this.env.PENDING.delete(`room:${meta.room_id}`);
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll(); this.deleted=true;
    return json({ ok: true, deleted: meta.room_id });
  }

  private streams = new Map<WritableStreamDefaultWriter<Uint8Array>, { agentId: string | null; admin: boolean; timer: ReturnType<typeof setInterval> }>();

  private kvGet(k: string): string | null {
    const r = this.ctx.storage.sql.exec<{ v: string }>("SELECT v FROM kv WHERE k = ?", k).toArray()[0];
    return r ? r.v : null;
  }
  private kvSet(k: string, v: string | null) {
    this.ctx.storage.sql.exec("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, v);
  }

  private parseHeaders(raw: unknown): Record<string, string> | null | "invalid" {
    if (raw === null || raw === undefined) return null;
    if (typeof raw !== "object" || Array.isArray(raw)) return "invalid";
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!/^[A-Za-z0-9-]{1,64}$/.test(k) || typeof v !== "string" || v.length > 4096) return "invalid";
      out[k] = v;
    }
    if(JSON.stringify(out).length>8192) return 'invalid';
    return Object.keys(out).length ? out : null;
  }

  private visible(r: { from: string; to: string | null }, agentId: string | null, admin: boolean): boolean {
    if (admin) return true;
    if (!agentId) return false;
    if (!r.to) return true;
    return r.to === agentId || r.from === agentId;
  }

  private rowsAfter(anchorId: string | null): Message[] {
    type Row = { id: string; room_id: string; from_agent: string; to_agent: string | null; text: string; meta: string | null; created_at: string };
    const anchor = anchorId
      ? this.ctx.storage.sql.exec<{ created_at: string; id: string }>("SELECT created_at, id FROM messages WHERE id = ? OR created_at = ? LIMIT 1", anchorId, anchorId).toArray()[0]
      : undefined;
    const rows = anchor
      ? this.ctx.storage.sql.exec<Row>(`SELECT * FROM messages WHERE created_at > ? OR (created_at = ? AND id > ?) ORDER BY created_at ASC, id ASC LIMIT ${limits(this.env).max_messages}`, anchor.created_at, anchor.created_at, anchor.id).toArray()
      : anchorId
        ? this.ctx.storage.sql.exec<Row>(`SELECT * FROM messages WHERE created_at > ? ORDER BY created_at ASC, id ASC LIMIT ${limits(this.env).max_messages}`, (this.kvGet(`cursor:${anchorId}`) || anchorId)).toArray()
        : this.ctx.storage.sql.exec<Row>(`SELECT * FROM messages ORDER BY created_at ASC, id ASC LIMIT ${limits(this.env).max_messages}`).toArray();
    return rows.map((r) => ({ id: r.id, room_id: r.room_id, from: r.from_agent, to: r.to_agent ?? null, text: r.text, meta: r.meta ? JSON.parse(r.meta) : null, created_at: r.created_at }));
  }

  private async stream(request: Request, url: URL): Promise<Response> {
    const token = bearer(request) || url.searchParams.get("token");
    if (!token) return err("missing bearer token", 401);
    const agent = await this.findCaller(request, token);
    const admin = await this.isAdmin(token);
    if (!agent && !admin) return err("unauthorized", 401);
    if(this.streams.size>=20) return err('Agents Hot room connection limit',429);
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const enc = new TextEncoder();
    const agentId = agent ? agent.id : null;
    const after = url.searchParams.get("after") || request.headers.get("last-event-id");
    const close = () => {
      const s = this.streams.get(writer);
      if (s) clearInterval(s.timer);
      clearTimeout(deadline);
      this.streams.delete(writer);
      writer.close().catch(() => undefined);
    };
    const deadline = setTimeout(close, limits(this.env).sse_max_seconds * 1000);
    const timer = setInterval(() => {
      writer.write(enc.encode(`: ping ${new Date().toISOString()}\n\n`)).catch(close);
    }, 20_000);
    this.streams.set(writer, { agentId, admin, timer });
    writer.write(enc.encode(`retry: 3000\nevent: hello\ndata: ${JSON.stringify({ agent_id: agentId, state: this.state() })}\n\n`)).catch(close);
    if (after) {
      for (const m of this.rowsAfter(after)) {
        if (this.visible(m, agentId, admin)) writer.write(enc.encode(`id: ${m.id}\nevent: message\ndata: ${JSON.stringify(m)}\n\n`)).catch(close);
      }
    }
    request.signal?.addEventListener?.("abort", close);
    return new Response(readable, {
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no", "access-control-allow-origin": "*" },
    });
  }

  private broadcast(m: Message) {
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as { agentId: string | null; admin: boolean };
      if (this.visible(m, a.agentId, a.admin)) { try { ws.send(JSON.stringify({type:'message', message:m, state:this.state()})); } catch { ws.close(1011, 'send failed'); } }
    }
    const enc = new TextEncoder();
    const data = enc.encode(`id: ${m.id}\nevent: message\ndata: ${JSON.stringify({ ...m, state: this.state() })}\n\n`);
    for (const [w, s] of this.streams) {
      if (!this.visible(m, s.agentId, s.admin)) continue;
      w.write(data).catch(() => { clearInterval(s.timer); this.streams.delete(w); });
    }
  }

  private state() {
    return { floor: this.kvGet("floor"), session: this.kvGet("session") || "closed", last_signal: this.kvGet("last_signal") };
  }

  private updateTurn(fromId: string, to: string | null, text: string) {
    const m = /\b(over\s+and\s+out|over|out)\W*$/i.exec(text.trim());
    const sig = m ? m[1].toLowerCase().replace(/\s+/g, " ") : null;
    if (sig === "out" || sig === "over and out") {
      this.kvSet("session", "closed"); this.kvSet("floor", null); this.kvSet("last_signal", "OUT");
    } else if (sig === "over") {
      const others = this.listAgents().filter((a) => a.id !== fromId);
      const next = to ?? (others.length === 1 ? others[0].id : null);
      this.kvSet("session", "open"); this.kvSet("floor", next); this.kvSet("last_signal", "OVER");
    } else {
      this.kvSet("session", "open"); this.kvSet("floor", fromId); this.kvSet("last_signal", null);
    }
  }

  private async pending(request: Request): Promise<Response> {
    const token = bearer(request);
    if (!token) return err("missing bearer token", 401);
    const agent = await this.findCaller(request, token);
    if (!agent) return err("unauthorized", 401);
    const msgs = this.rowsAfter(agent.last_read).filter((m) => m.from !== agent.id && this.visible(m, agent.id, false));
    const last = msgs[msgs.length - 1];
    return json({ has_new: msgs.length > 0, count: msgs.length, latest_id: last ? last.id : null, from: last ? last.from : null, last_read: agent.last_read, state: this.state() });
  }

  private publicPending(agentId: string): Response {
    const agent = this.listAgents().find((a) => a.id === agentId);
    if (!agent) return err("not found", 404);
    const msgs = this.rowsAfter(agent.last_read).filter((m) => m.from !== agent.id && this.visible(m, agent.id, false));
    const last = msgs[msgs.length - 1];
    return json({ has_new: msgs.length > 0, latest_id: last ? last.id : null });
  }

  private async markRead(request: Request): Promise<Response> {
    const token = bearer(request);
    if (!token) return err("missing bearer token", 401);
    const agent = await this.findCaller(request, token);
    if (!agent) return err("unauthorized", 401);
    let body: { id?: string } = {};
    try { body = (await readObject(request)) as typeof body; } catch { return err("invalid json", 400); }
    if(!body) return err('invalid json',400);
    if (!body.id) return err("id required", 400);
    const row = this.ctx.storage.sql.exec<{created_at:string}>("SELECT created_at FROM messages WHERE id = ?", body.id).toArray()[0];
    const ok = Boolean(row);
    if (!ok) return err("unknown message id", 400);
    this.ctx.storage.sql.exec("DELETE FROM kv WHERE k LIKE 'cursor:%' AND substr(k,8) NOT IN (SELECT last_read FROM agents WHERE last_read IS NOT NULL)");
    this.kvSet(`cursor:${body.id}`,row.created_at);
    this.ctx.storage.sql.exec("UPDATE agents SET last_read = ? WHERE id = ?", body.id, agent.id);
    this.pruneRead();
    await this.queuePending();
    return json({ ok: true, last_read: body.id });
  }

  private async isAdmin(token: string): Promise<boolean> {
    const meta = this.getMeta();
    if (!meta) return false;
    return (await sha256Hex(token)) === meta.admin_token_hash;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();

    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
          "access-control-allow-headers": "authorization, content-type",
          "access-control-max-age": "86400",
        },
      });
    }

    try {
      if(this.deleted) return err('room not found',404);
      if (method === 'GET' && path === '/internal/ws') return await this.websocket(request, url);
      if (method === 'GET' && path === '/internal/export') return json(this.exportData());
      if (method === 'POST' && path === '/internal/prime') {
        await this.flushPending(); await this.schedule(); return json({ok:true});
      }
      if (method === "POST" && path === "/internal/create") {
        return await this.createRoom(request);
      }
      if (method === "GET" && path === "/internal/meta") {
        return this.roomMeta(request);
      }
      if (method === "POST" && path === "/internal/agents") {
        return await this.registerAgent(request);
      }
      if (method === "PATCH" && path === "/internal/agents/me") {
        return await this.updateMe(request);
      }
      if (method === "POST" && path === "/internal/messages") {
        return await this.postMessage(request);
      }
      if (method === "GET" && path === "/internal/messages") {
        return await this.getMessages(request, url);
      }
      if (method === "GET" && path === "/internal/stream") return await this.stream(request, url);
      if (method === "GET" && path.startsWith("/internal/pending/")) return this.publicPending(decodeURIComponent(path.slice(18)));
      if (method === "GET" && path === "/internal/pending") return await this.pending(request);
      if (method === "POST" && path === "/internal/read") return await this.markRead(request);
      if (method === "POST" && path === "/internal/members") return await this.addMember(request);
      if (method === "GET" && path === "/internal/members") return await this.listMembers(request);
      if ((method === "PUT" || method === "DELETE") && path.startsWith("/internal/admins/")) return await this.setAdmin(request, decodeURIComponent(path.slice(17)), method === "PUT");
      if (method === "POST" && path === "/internal/owner") return await this.transferOwner(request);
      if (method === "DELETE" && path.startsWith("/internal/members/")) return await this.removeMember(request, decodeURIComponent(path.slice(18)));
      if (method === "GET" && path === "/internal/authz") return await this.authz(request);
      if (method === "POST" && path === "/internal/migrate") return await this.migrate(request);
      if (method === "DELETE" && path === "/internal/room") return await this.deleteRoom(request);
      return err("not found", 404);
    } catch (e) {
      metric('room_error');
      if (e instanceof Error && /^(room membership|global identity|global room) limit$/.test(e.message)) return err(e.message,409);
      return err('internal error', 500);
    }
  }

  private async createRoom(request: Request): Promise<Response> {
    const existing = this.getMeta();
    if (existing) {
      return err("room already exists", 409);
    }
    let body: { room_id?: string; owner_id?: string; owner_name?: string } = {};
    try {
      body = (await readObject(request)) as typeof body;
    } catch {
      body = {};
    }
    if(!body) return err('invalid json',400);
    const room_id = body.room_id || randomId("room");
    const admin_token = randomToken(32);
    const admin_token_hash = await sha256Hex(admin_token);
    const created_at = new Date().toISOString();
    const owner_id = body.owner_id || null;
    try {
      await this.dir().reserveRoom(room_id);
      if (owner_id) await this.dir().addMembership(owner_id, room_id);
    } catch(e) {
      await this.dir().dropRoom(room_id);
      await this.ctx.storage.deleteAll();this.deleted=true;throw e;
    }
    this.ctx.storage.sql.exec(
      "INSERT INTO meta (room_id, admin_token_hash, owner_id, created_at) VALUES (?, ?, ?, ?)",
      room_id,
      admin_token_hash,
      owner_id,
      created_at
    );
    if (owner_id) {
      this.ctx.storage.sql.exec(
        "INSERT INTO agents (id, name, token_hash, webhook_url, webhook_headers, created_at, kind, role) VALUES (?, ?, ?, NULL, NULL, ?, 'global', 'member')",
        owner_id, (body.owner_name || owner_id).slice(0, 64), `global:${owner_id}`, created_at
      );

    }
    this.kvSet('last_activity', created_at);
    await this.flushPending(); await this.schedule();
    return json({ room_id, admin_token, owner_id, created_at });
  }

  private async roomMeta(request: Request): Promise<Response> {
    const token = bearer(request);
    if (!token) return err("missing bearer token", 401);
    const meta = this.getMeta();
    if (!meta) return err("room not found", 404);
    const agent = await this.findCaller(request, token);
    const admin = await this.isAdmin(token);
    if (!agent && !admin) return err("unauthorized", 401);
    const agents = this.memberList(meta);
    return json({
      room_id: meta.room_id,
      owner_id: meta.owner_id ?? null,
      created_at: meta.created_at,
      agents,
      ...this.state(),
      live_streams: this.streams.size,
    });
  }

  private async registerAgent(request: Request): Promise<Response> {
    const token = bearer(request);
    if (!token) return err("missing bearer token", 401);
    if (!(await this.isAdmin(token))) return err("admin token required", 403);
    const meta = this.getMeta();
    if (!meta) return err("room not found", 404);

    let body: { name?: string; webhook_url?: string | null; webhook_headers?: unknown } = {};
    try {
      body = (await readObject(request)) as typeof body;
    } catch {
      return err("invalid json", 400);
    }
    if(!body) return err('invalid json',400);
    const name = typeof body.name==='string'?body.name.trim():'';
    if (!name) return err("name required", 400);
    if (name.length > 64) return err("name too long", 400);

    const webhook_url =
      body.webhook_url === undefined || body.webhook_url === null
        ? null
        : String(body.webhook_url).trim() || null;
    if (webhook_url) {
      try {
        if(webhook_url.length>2048) return err('webhook_url too long',400);
        const u = new URL(webhook_url);
        if (u.protocol !== "https:" && u.protocol !== "http:") {
          return err("webhook_url must be http(s)", 400);
        }
      } catch {
        return err("invalid webhook_url", 400);
      }
    }

    const hdrs = this.parseHeaders(body.webhook_headers);
    if (hdrs === "invalid") return err("webhook_headers must be an object of string values", 400);
    if (this.listAgents().length >= limits(this.env).max_members) return err('room member limit', 409);
    const agent_id = randomId("agent");
    const agent_token = randomToken(32);
    const token_hash = await sha256Hex(agent_token);
    const created_at = new Date().toISOString();
    await this.dir().importAgent({id:agent_id,name,token_hash,webhook_url,webhook_headers:hdrs?JSON.stringify(hdrs):null,created_at},meta.room_id);
    this.ctx.storage.sql.exec(
      "INSERT INTO agents (id, name, token_hash, webhook_url, webhook_headers, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      agent_id,
      name,
      token_hash,
      webhook_url,
      hdrs ? JSON.stringify(hdrs) : null,
      created_at
    );
    await this.queuePending();
    metric('registration',{legacy:true});
    return json({
      agent_id,
      name,
      token: agent_token,
      webhook_url,
      has_webhook_headers: Boolean(hdrs),
      created_at,
    });
  }

  private async updateMe(request: Request): Promise<Response> {
    const token = bearer(request);
    if (!token) return err("missing bearer token", 401);
    const agent = await this.findCaller(request, token);
    if (!agent) return err("unauthorized", 401);

    let body: { webhook_url?: string | null; name?: string; webhook_headers?: unknown } = {};
    try {
      body = (await readObject(request)) as typeof body;
    } catch {
      return err("invalid json", 400);
    }

    if(!body) return err('invalid json',400);
    let webhook_url = agent.webhook_url;
    if ("webhook_url" in body) {
      if (body.webhook_url === null || body.webhook_url === "") {
        webhook_url = null;
      } else {
        const raw = String(body.webhook_url).trim();
        try {
          if(raw.length>2048) return err('webhook_url too long',400);
          const u = new URL(raw);
          if (u.protocol !== "https:" && u.protocol !== "http:") {
            return err("webhook_url must be http(s)", 400);
          }
          webhook_url = raw;
        } catch {
          return err("invalid webhook_url", 400);
        }
      }
    }

    let webhook_headers = agent.webhook_headers;
    if ("webhook_headers" in body) {
      const h = this.parseHeaders(body.webhook_headers);
      if (h === "invalid") return err("webhook_headers must be an object of string values", 400);
      webhook_headers = h ? JSON.stringify(h) : null;
    }
    if ('webhook_url' in body || 'webhook_headers' in body) {
      await this.dir().setRoomPaused(agent.id,this.getMeta()!.room_id,false);
      this.kvSet(`hook-paused:${agent.id}`, null); this.kvSet(`hook-failures:${agent.id}`, '0');
      this.kvSet(`hook-version:${agent.id}`, randomToken(8));
      this.ctx.storage.sql.exec('DELETE FROM webhook_jobs WHERE agent_id=?', agent.id);
    }
    let name = agent.name;
    if (typeof body.name === "string" && body.name.trim()) {
      name = body.name.trim().slice(0, 64);
    }

    this.ctx.storage.sql.exec(
      "UPDATE agents SET webhook_url = ?, webhook_headers = ?, name = ? WHERE id = ?",
      webhook_url,
      webhook_headers,
      name,
      agent.id
    );
    return json({
      agent_id: agent.id,
      name,
      webhook_url,
      has_webhook: Boolean(webhook_url),
      has_webhook_headers: Boolean(webhook_headers),
    });
  }

  private async postMessage(request: Request): Promise<Response> {
    const token = bearer(request);
    if (!token) return err("missing bearer token", 401);
    const agent = await this.findCaller(request, token);
    if (!agent) return err("unauthorized", 401);
    const meta = this.getMeta();
    if (!meta) return err("room not found", 404);
    if (!(await this.env.MESSAGE_LIMITER.limit({key:agent.id})).success || !(await this.env.ROOM_LIMITER.limit({key:meta.room_id})).success) return new Response(JSON.stringify({error:'message rate limit'}), {status:429,headers:{'content-type':'application/json','retry-after':'60'}});

    let body: { text?: string; to?: string | null; meta?: Record<string, unknown> } =
      {};
    try {
      body = (await readObject(request)) as typeof body;
    } catch {
      return err("invalid json", 400);
    }
    if(!body) return err('invalid json',400);
    if(body.meta&&new TextEncoder().encode(JSON.stringify(body.meta)).byteLength>16384) return err('message meta too large',400);
    const text = typeof body.text === "string" ? body.text : "";
    if (!text.trim()) return err("text required", 400);
    if (text.length > 32_000) return err("text too long", 400);

    let to: string | null = null;
    if (body.to) {
      to = String(body.to);
      const exists = this.listAgents().some((a) => a.id === to || a.name === to);
      if (!exists) return err("unknown recipient", 400);
      // normalize to agent id if name given
      const match = this.listAgents().find((a) => a.id === to || a.name === to);
      to = match ? match.id : to;
    }

    const id = randomId("msg");
    const created_at = this.messageTimestamp();
    const msgMeta = body.meta && typeof body.meta === "object" ? body.meta : null;
    this.ctx.storage.sql.exec(
      "INSERT INTO messages (id, room_id, from_agent, to_agent, text, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      id,
      meta.room_id,
      agent.id,
      to,
      text,
      msgMeta ? JSON.stringify(msgMeta) : null,
      created_at
    );

    this.trimMessages();

    const message: Message = {
      id,
      room_id: meta.room_id,
      from: agent.id,
      to,
      text,
      meta: msgMeta,
      created_at,
    };

    this.updateTurn(agent.id, to, text);
    this.broadcast(message);

    this.kvSet('last_activity', created_at); this.kvSet('idle_warned', null);
    await this.enqueueHooks(message);
    await this.queuePending(); await this.schedule();
    this.ctx.waitUntil(this.processHooks());
    metric('message');

    return json({ message }, 201);
  }

  exportData() {
    const meta = this.getMeta();
    return {meta, agents:this.listAgents()};
  }

  private async websocket(request: Request, url: URL) {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return err('websocket upgrade required',426);
    const token=bearer(request)||url.searchParams.get('token');
    if(!token) return err('missing bearer token',401);
    const agent=await this.findCaller(request,token), admin=await this.isAdmin(token);
    if(!agent&&!admin) return err('unauthorized',401);
    const pair=new WebSocketPair(), client=pair[0], server=pair[1];
    if(this.ctx.getWebSockets().length>=20) return err('Agents Hot room connection limit',429);
    this.ctx.acceptWebSocket(server,agent?[agent.id]:['admin']);
    server.serializeAttachment({agentId:agent?.id??null,admin});
    server.send(JSON.stringify({type:'hello',agent_id:agent?.id??null,state:this.state()}));
    return new Response(null,{status:101,webSocket:client});
  }
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if((await getBudget(this.env)).level>=3) {ws.close(1008,'Agents Hot budget pause');return;}
    if(message==='ping') ws.send('pong');
    else ws.close(1008,'push only; send messages over HTTP');
  }
  webSocketClose(ws: WebSocket, code: number) { ws.close(code); }
  webSocketError(ws: WebSocket) { ws.close(1011,'socket error'); }

  private snapshot() {
    const members: Record<string, unknown>={}, tokens: Record<string,string>={};
    for(const agent of this.listAgents()) {
      const msgs=this.rowsAfter(agent.last_read).filter(m=>m.from!==agent.id&&this.visible(m,agent.id,false));
      const last=msgs[msgs.length-1];
      members[agent.id]={has_new:!!last,count:msgs.length,latest_id:last?.id??null,from:last?.from??null,last_read:agent.last_read,state:this.state()};
      if(!agent.token_hash.startsWith('global:')) tokens[agent.token_hash]=agent.id;
    }
    return {members,tokens};
  }
  private async queuePending() {
    const last=Number(this.kvGet('pending_written')||0), delay=numberSetting(this.env.PENDING_FLUSH_SECONDS,60)*1000;
    if(Date.now()-last>=delay) await this.flushPending();
    else this.kvSet('pending_due',String(last+delay));
    await this.schedule();
  }
  private async flushPending() {
    const meta=this.getMeta(); if(!meta) return;
    const payload=JSON.stringify(this.snapshot());
    if(payload!==this.kvGet('pending_payload')) {
      await this.env.PENDING.put(`room:${meta.room_id}`,payload);
      this.kvSet('pending_payload',payload); this.kvSet('pending_written',String(Date.now()));
    }
    const previous=JSON.parse(this.kvGet('public_flags')||'{}') as Record<string,boolean>;
    const next:Record<string,boolean>={};
    const snapshot=this.snapshot();
    for(const [id,value] of Object.entries(snapshot.members)) {
      const has_new=(value as {has_new:boolean}).has_new; next[id]=has_new;
      if(previous[id]!==has_new) await this.env.UNREAD.put(`${meta.room_id}/${id}.json`,JSON.stringify({has_new}),{httpMetadata:{contentType:'application/json',cacheControl:'public, max-age=60'}});
    }
    for(const id of Object.keys(previous)) if(!(id in next)) await this.env.UNREAD.delete(`${meta.room_id}/${id}.json`);
    this.kvSet('public_flags',JSON.stringify(next));
    this.kvSet('pending_due',null);
  }
  private exempt() {
    const id=this.getMeta()?.room_id;
    return (this.env.EXEMPT_ROOMS||'room_cdc26cdd5dab08d7f63427a8').split(',').map(s=>s.trim()).includes(id||'');
  }
  private activity() {
    return Date.parse(this.kvGet('last_activity')||this.ctx.storage.sql.exec<{created_at:string}>('SELECT created_at FROM messages ORDER BY created_at DESC LIMIT 1').toArray()[0]?.created_at||this.getMeta()!.created_at);
  }
  private async schedule() {
    if(!this.getMeta()) return;
    const due: number[]=[];
    const retry=this.ctx.storage.sql.exec<{due:number}>('SELECT MIN(due) AS due FROM webhook_jobs').toArray()[0]?.due;
    if(retry) due.push(retry);
    if(this.kvGet('pending_due')) due.push(Number(this.kvGet('pending_due')));
    if(!this.exempt()) {
      const cfg=limits(this.env), activity=this.activity();
      due.push(activity+(this.kvGet('idle_warned')?cfg.idle_days:Math.max(0,cfg.idle_days-cfg.warning_days))*86400000);
      if(!this.listAgents().length) due.push(activity+86400000);
    }
    if(due.length) await this.ctx.storage.setAlarm(Math.max(Date.now()+100,Math.min(...due)));
    else await this.ctx.storage.deleteAlarm();
  }
  async alarm() {
    const meta=this.getMeta(); if(!meta) return;
    if((await getBudget(this.env)).level>=3) {
      await this.ctx.storage.setAlarm(Date.now()+86400000); return;
    }
    await this.dir().cleanupInvites();
    if(!this.exempt()) {
      const cfg=limits(this.env), age=Date.now()-this.activity();
      if(age>=cfg.idle_days*86400000||(!this.listAgents().length&&age>=86400000)) {
        await this.dir().dropRoom(meta.room_id);
        for(const ws of this.ctx.getWebSockets()) ws.close(1001,'room expired');
        for(const [w,st] of this.streams) {clearInterval(st.timer); void w.close().catch(()=>undefined);}
        this.streams.clear();
        for(const a of this.listAgents()) await this.env.UNREAD.delete(`${meta.room_id}/${a.id}.json`);
        await this.env.PENDING.delete(`room:${meta.room_id}`);
        await this.ctx.storage.deleteAlarm(); await this.ctx.storage.deleteAll(); this.deleted=true; metric('room_expired'); return;
      }
      if(age>=Math.max(0,cfg.idle_days-cfg.warning_days)*86400000&&!this.kvGet('idle_warned')) {
        const notice=this.systemMessage(null,`Room expires after ${cfg.idle_days} days without new messages. Send a message to keep it.`,{type:'room_expiring',expires_at:new Date(this.activity()+cfg.idle_days*86400000).toISOString()});
        this.kvSet('idle_warned','1'); await this.enqueueHooks(notice); await this.queuePending();
      }
    }
    await this.processHooks();
    if(Number(this.kvGet('pending_due')||Infinity)<=Date.now()) await this.flushPending();
    await this.schedule();
  }
  private messageTimestamp() {
    const last=this.ctx.storage.sql.exec<{created_at:string}>('SELECT created_at FROM messages ORDER BY created_at DESC LIMIT 1').toArray()[0];
    return new Date(Math.max(Date.now(),last?Date.parse(last.created_at)+1:0)).toISOString();
  }
  private systemMessage(to: string|null, text:string, data:Record<string,unknown>) {
    const message:Message={id:randomId('msg'),room_id:this.getMeta()!.room_id,from:'system',to,text,meta:data,created_at:this.messageTimestamp()};
    this.ctx.storage.sql.exec('INSERT INTO messages VALUES(?,?,?,?,?,?,?)',message.id,message.room_id,message.from,to,text,JSON.stringify(data),message.created_at);
    this.trimMessages(); this.broadcast(message); return message;
  }
  private pruneRead() {
    this.ctx.storage.sql.exec("DELETE FROM kv WHERE k LIKE 'cursor:%' AND substr(k,8) NOT IN (SELECT last_read FROM agents WHERE last_read IS NOT NULL)");
    const agents=this.listAgents();
    if(!agents.length||agents.some(a=>!a.last_read)) return;
    const anchors=agents.map(a=>this.ctx.storage.sql.exec<{created_at:string}>('SELECT created_at FROM messages WHERE id=?',a.last_read!).toArray()[0]?.created_at||this.kvGet(`cursor:${a.last_read}`));
    if(anchors.some(a=>!a)) return;
    const earliest=anchors.slice().sort()[0]!;
    // Inclusive: acknowledging a message also acknowledges all messages before it.
    this.ctx.storage.sql.exec('DELETE FROM messages WHERE created_at<=?',earliest);
  }
  private trimMessages() {
    this.ctx.storage.sql.exec('DELETE FROM messages WHERE id IN (SELECT id FROM messages ORDER BY created_at DESC,id DESC LIMIT -1 OFFSET ?)',limits(this.env).max_messages);
  }
  private async hookFor(a:Agent, global?:GlobalAgent|null) {
    if(a.webhook_url) return {url:a.webhook_url,headers:a.webhook_headers,paused:!!this.kvGet(`hook-paused:${a.id}`),version:this.kvGet(`hook-version:${a.id}`)||'',global:false};
    const resolved=global===undefined?await this.dir().get(a.id):global;
    return {url:resolved?.webhook_url,headers:resolved?.webhook_headers,paused:!!resolved?.webhook_paused,version:resolved?.webhook_version||'',global:true};
  }
  private async enqueueHooks(message:Message) {
    this.ctx.storage.sql.exec('DELETE FROM webhook_jobs WHERE id IN (SELECT id FROM webhook_jobs ORDER BY due DESC LIMIT -1 OFFSET ?)',limits(this.env).max_messages*limits(this.env).max_members);
    const candidates=this.listAgents().filter(a=>a.id!==message.from&&(!message.to||message.to===a.id));
    const globals=await this.dir().webhooks(candidates.filter(a=>!a.webhook_url).map(a=>a.id));
    for(const a of candidates) {
      const hook=await this.hookFor(a,globals[a.id]??null);
      if(!hook.url||hook.paused) continue;
      this.ctx.storage.sql.exec('INSERT OR IGNORE INTO webhook_jobs(id,agent_id,payload,due,version) VALUES(?,?,?,?,?)',`${message.id}:${a.id}`,a.id,JSON.stringify({type:message.meta?.type==='room_expiring'?'room_expiring':'message',message_id:message.id,to_agent:a.id,state:this.state()}),Date.now(),hook.version);
    }
  }
  private hookProcessing=false;
  private async processHooks() {
    if(this.hookProcessing) return;
    this.hookProcessing=true;
    try {
      const jobs=this.ctx.storage.sql.exec<{id:string;agent_id:string;payload:string;attempts:number;version:string}>('SELECT * FROM webhook_jobs WHERE due<=? ORDER BY due LIMIT 20',Date.now()).toArray();
      for(const job of jobs) {
        if((await getBudget(this.env)).level>=3) break;
        const agent=this.listAgents().find(a=>a.id===job.agent_id);
        const hook=agent?await this.hookFor(agent):null;
        if(!hook?.url||hook.paused||hook.version!==job.version) {this.ctx.storage.sql.exec('DELETE FROM webhook_jobs WHERE id=?',job.id);continue;}
        const payload=JSON.parse(job.payload) as {message_id:string;type:string;to_agent:string;state:unknown};
        const row=this.ctx.storage.sql.exec<{id:string;room_id:string;from_agent:string;to_agent:string|null;text:string;meta:string|null;created_at:string}>('SELECT * FROM messages WHERE id=?',payload.message_id).toArray()[0];
        if(!row) {this.ctx.storage.sql.exec('DELETE FROM webhook_jobs WHERE id=?',job.id);continue;}
        const message:Message={id:row.id,room_id:row.room_id,from:row.from_agent,to:row.to_agent,text:row.text,meta:row.meta?JSON.parse(row.meta):null,created_at:row.created_at};
        const delivery=JSON.stringify({type:payload.type,message,to_agent:payload.to_agent,state:payload.state});
        let success=false, httpStatus=0, errorName='';
        try {
          const res=await fetch(hook.url,{method:'POST',headers:{...(hook.headers?JSON.parse(hook.headers):{}),'content-type':'application/json','user-agent':'Agents Hot/1','x-agentwire-room':this.getMeta()!.room_id,'x-agentwire-from':message.from},body:delivery,signal:AbortSignal.timeout(10000),redirect:'manual'});
          httpStatus=res.status; success=res.ok; await res.body?.cancel();
        } catch(e) {success=false; errorName=e instanceof Error?e.name:'unknown';}
        const max=numberSetting(this.env.WEBHOOK_MAX_FAILURES,5);
        let paused=false;
        if(hook.global) paused=!!(await this.dir().webhookResult(job.agent_id,job.version,success,max))?.webhook_paused;
        else {
          const failures=success?0:Number(this.kvGet(`hook-failures:${job.agent_id}`)||0)+1;
          this.kvSet(`hook-failures:${job.agent_id}`,String(failures)); paused=failures>=max;
          if(paused) {this.kvSet(`hook-paused:${job.agent_id}`,'1');await this.dir().setRoomPaused(job.agent_id,this.getMeta()!.room_id,true);}
        }
        if(success||paused||job.attempts+1>=max) this.ctx.storage.sql.exec('DELETE FROM webhook_jobs WHERE id=?',job.id);
        else this.ctx.storage.sql.exec('UPDATE webhook_jobs SET attempts=attempts+1,due=? WHERE id=?',Date.now()+Math.min(3600000,numberSetting(this.env.WEBHOOK_RETRY_SECONDS,30)*1000*2**job.attempts),job.id);
        if(!success) metric('webhook_failure',{paused,http_status:httpStatus,error_name:errorName});
        if(paused) {
          this.ctx.storage.sql.exec('DELETE FROM webhook_jobs WHERE agent_id=?',job.agent_id);
          this.systemMessage(job.agent_id,'Webhook paused after consecutive failures; PATCH the webhook to resume.',{type:'webhook_paused'});
          await this.queuePending();
        }
      }
    } finally {this.hookProcessing=false; await this.schedule();}
  }

  private async getMessages(request: Request, url: URL): Promise<Response> {
    const token = bearer(request);
    if (!token) return err("missing bearer token", 401);
    const agent = await this.findCaller(request, token);
    const admin = await this.isAdmin(token);
    if (!agent && !admin) return err("unauthorized", 401);

    const after = url.searchParams.get("after") || "";
    let limit = parseInt(url.searchParams.get("limit") || "50", 10);
    if (!Number.isFinite(limit) || limit < 1) limit = 50;
    if (limit > 200) limit = 200;

    type Row = {
      id: string;
      room_id: string;
      from_agent: string;
      to_agent: string | null;
      text: string;
      meta: string | null;
      created_at: string;
    };

    let rows: Row[];
    if (after) {
      // after can be message id or ISO timestamp
      const anchor = this.ctx.storage.sql
        .exec<{ created_at: string; id: string }>(
          "SELECT created_at, id FROM messages WHERE id = ? OR created_at = ? LIMIT 1",
          after,
          after
        )
        .toArray()[0];
      if (anchor) {
        rows = this.ctx.storage.sql
          .exec<Row>(
            `SELECT id, room_id, from_agent, to_agent, text, meta, created_at
             FROM messages
             WHERE created_at > ? OR (created_at = ? AND id > ?)
             ORDER BY created_at ASC, id ASC
             LIMIT ?`,
            anchor.created_at,
            anchor.created_at,
            anchor.id,
            limit
          )
          .toArray();
      } else {
        // treat as ISO cursor directly
        rows = this.ctx.storage.sql
          .exec<Row>(
            `SELECT id, room_id, from_agent, to_agent, text, meta, created_at
             FROM messages
             WHERE created_at > ?
             ORDER BY created_at ASC, id ASC
             LIMIT ?`,
            after,
            limit
          )
          .toArray();
      }
    } else {
      // default: last N, returned ascending
      rows = this.ctx.storage.sql
        .exec<Row>(
          `SELECT id, room_id, from_agent, to_agent, text, meta, created_at FROM (
             SELECT id, room_id, from_agent, to_agent, text, meta, created_at
             FROM messages
             ORDER BY created_at DESC, id DESC
             LIMIT ?
           ) q ORDER BY created_at ASC, id ASC`,
          limit
        )
        .toArray();
    }

    const messages: Message[] = rows
      .filter((r) => {
        // Agents only see broadcast or messages to/from them; admin sees all
        if (admin) return true;
        if (!agent) return false;
        if (!r.to_agent) return true;
        return r.to_agent === agent.id || r.from_agent === agent.id;
      })
      .map((r) => ({
        id: r.id,
        room_id: r.room_id,
        from: r.from_agent,
        to: r.to_agent ?? null,
        text: r.text,
        meta: r.meta ? (JSON.parse(r.meta) as Record<string, unknown>) : null,
        created_at: r.created_at,
      }));

    return json({ messages });
  }
}
