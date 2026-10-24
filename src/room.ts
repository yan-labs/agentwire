import { DurableObject } from "cloudflare:workers";

export interface Env {
  ROOM: DurableObjectNamespace<Room>;
}

type Agent = {
  id: string;
  name: string;
  token_hash: string;
  webhook_url: string | null;
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
  created_at: string;
};

const MAX_MESSAGES = 500;

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
    this.ctx.blockConcurrencyWhile(async () => {
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
      `);
    });
  }

  private getMeta(): RoomMeta | null {
    const rows = this.ctx.storage.sql
      .exec<RoomMeta>("SELECT room_id, admin_token_hash, created_at FROM meta LIMIT 1")
      .toArray();
    return rows[0] ?? null;
  }

  private listAgents(): Agent[] {
    return this.ctx.storage.sql
      .exec<Agent>(
        "SELECT id, name, token_hash, webhook_url, created_at FROM agents ORDER BY created_at ASC"
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
        "SELECT id, name, token_hash, webhook_url, created_at FROM agents WHERE token_hash = ?",
        hash
      )
      .toArray();
    const a = rows[0];
    if (!a) return null;
    return { ...a, webhook_url: a.webhook_url ?? null };
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
          "access-control-allow-methods": "GET, POST, PATCH, PUT, OPTIONS",
          "access-control-allow-headers": "authorization, content-type",
          "access-control-max-age": "86400",
        },
      });
    }

    try {
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
      return err("not found", 404);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(msg, 500);
    }
  }

  private async createRoom(request: Request): Promise<Response> {
    const existing = this.getMeta();
    if (existing) {
      return err("room already exists", 409);
    }
    let body: { room_id?: string } = {};
    try {
      body = (await request.json()) as { room_id?: string };
    } catch {
      body = {};
    }
    const room_id = body.room_id || randomId("room");
    const admin_token = randomToken(32);
    const admin_token_hash = await sha256Hex(admin_token);
    const created_at = new Date().toISOString();
    this.ctx.storage.sql.exec(
      "INSERT INTO meta (room_id, admin_token_hash, created_at) VALUES (?, ?, ?)",
      room_id,
      admin_token_hash,
      created_at
    );
    return json({ room_id, admin_token, created_at });
  }

  private async roomMeta(request: Request): Promise<Response> {
    const token = bearer(request);
    if (!token) return err("missing bearer token", 401);
    const meta = this.getMeta();
    if (!meta) return err("room not found", 404);
    const agent = await this.findAgentByToken(token);
    const admin = await this.isAdmin(token);
    if (!agent && !admin) return err("unauthorized", 401);
    const agents = this.listAgents().map((a) => ({
      id: a.id,
      name: a.name,
      has_webhook: Boolean(a.webhook_url),
      created_at: a.created_at,
    }));
    return json({
      room_id: meta.room_id,
      created_at: meta.created_at,
      agents,
    });
  }

  private async registerAgent(request: Request): Promise<Response> {
    const token = bearer(request);
    if (!token) return err("missing bearer token", 401);
    if (!(await this.isAdmin(token))) return err("admin token required", 403);
    const meta = this.getMeta();
    if (!meta) return err("room not found", 404);

    let body: { name?: string; webhook_url?: string | null } = {};
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return err("invalid json", 400);
    }
    const name = (body.name || "").trim();
    if (!name) return err("name required", 400);
    if (name.length > 64) return err("name too long", 400);

    const webhook_url =
      body.webhook_url === undefined || body.webhook_url === null
        ? null
        : String(body.webhook_url).trim() || null;
    if (webhook_url) {
      try {
        const u = new URL(webhook_url);
        if (u.protocol !== "https:" && u.protocol !== "http:") {
          return err("webhook_url must be http(s)", 400);
        }
      } catch {
        return err("invalid webhook_url", 400);
      }
    }

    const agent_id = randomId("agent");
    const agent_token = randomToken(32);
    const token_hash = await sha256Hex(agent_token);
    const created_at = new Date().toISOString();
    this.ctx.storage.sql.exec(
      "INSERT INTO agents (id, name, token_hash, webhook_url, created_at) VALUES (?, ?, ?, ?, ?)",
      agent_id,
      name,
      token_hash,
      webhook_url,
      created_at
    );
    return json({
      agent_id,
      name,
      token: agent_token,
      webhook_url,
      created_at,
    });
  }

  private async updateMe(request: Request): Promise<Response> {
    const token = bearer(request);
    if (!token) return err("missing bearer token", 401);
    const agent = await this.findAgentByToken(token);
    if (!agent) return err("unauthorized", 401);

    let body: { webhook_url?: string | null; name?: string } = {};
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return err("invalid json", 400);
    }

    let webhook_url = agent.webhook_url;
    if ("webhook_url" in body) {
      if (body.webhook_url === null || body.webhook_url === "") {
        webhook_url = null;
      } else {
        const raw = String(body.webhook_url).trim();
        try {
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

    let name = agent.name;
    if (typeof body.name === "string" && body.name.trim()) {
      name = body.name.trim().slice(0, 64);
    }

    this.ctx.storage.sql.exec(
      "UPDATE agents SET webhook_url = ?, name = ? WHERE id = ?",
      webhook_url,
      name,
      agent.id
    );
    return json({
      agent_id: agent.id,
      name,
      webhook_url,
      has_webhook: Boolean(webhook_url),
    });
  }

  private async postMessage(request: Request): Promise<Response> {
    const token = bearer(request);
    if (!token) return err("missing bearer token", 401);
    const agent = await this.findAgentByToken(token);
    if (!agent) return err("unauthorized", 401);
    const meta = this.getMeta();
    if (!meta) return err("room not found", 404);

    let body: { text?: string; to?: string | null; meta?: Record<string, unknown> } =
      {};
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return err("invalid json", 400);
    }
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
    const created_at = new Date().toISOString();
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

    // Cap at last MAX_MESSAGES
    const countRow = this.ctx.storage.sql
      .exec<{ c: number }>("SELECT COUNT(*) AS c FROM messages")
      .one();
    if (countRow.c > MAX_MESSAGES) {
      this.ctx.storage.sql.exec(
        `DELETE FROM messages WHERE id IN (
          SELECT id FROM messages ORDER BY created_at ASC LIMIT ?
        )`,
        countRow.c - MAX_MESSAGES
      );
    }

    const message: Message = {
      id,
      room_id: meta.room_id,
      from: agent.id,
      to,
      text,
      meta: msgMeta,
      created_at,
    };

    // Fire-and-forget webhook fan-out (not to sender; respect `to` if set)
    const peers = this.listAgents().filter((a) => {
      if (a.id === agent.id) return false;
      if (!a.webhook_url) return false;
      if (to && a.id !== to) return false;
      return true;
    });
    for (const peer of peers) {
      const url = peer.webhook_url!;
      this.ctx.waitUntil(
        fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "user-agent": "AgentWire/0.1",
            "x-agentwire-room": meta.room_id,
            "x-agentwire-from": agent.id,
          },
          body: JSON.stringify({
            type: "message",
            message,
            to_agent: peer.id,
          }),
        }).catch(() => undefined)
      );
    }

    return json({ message }, 201);
  }

  private async getMessages(request: Request, url: URL): Promise<Response> {
    const token = bearer(request);
    if (!token) return err("missing bearer token", 401);
    const agent = await this.findAgentByToken(token);
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
