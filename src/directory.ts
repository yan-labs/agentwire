import { DurableObject } from "cloudflare:workers";
import type { Env } from "./room";

export type GlobalAgent = {
  id: string;
  name: string;
  webhook_url: string | null;
  webhook_headers: string | null;
  created_at: string;
};

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Global identity directory (singleton DO named "global").
 * Holds agent identities, token hashes (one agent may have several, e.g. a
 * migrated per-room legacy token), room memberships and invite codes.
 */
export class Directory extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS agents (
          id TEXT PRIMARY KEY, name TEXT NOT NULL,
          webhook_url TEXT, webhook_headers TEXT, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tokens (hash TEXT PRIMARY KEY, agent_id TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS memberships (
          agent_id TEXT NOT NULL, room_id TEXT NOT NULL, joined_at TEXT NOT NULL,
          PRIMARY KEY (agent_id, room_id)
        );
        CREATE INDEX IF NOT EXISTS idx_mem_room ON memberships(room_id);
        CREATE TABLE IF NOT EXISTS invites (
          hash TEXT PRIMARY KEY, room_id TEXT NOT NULL, created_by TEXT,
          uses_left INTEGER NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL
        );
      `);
    });
  }

  private get sql() { return this.ctx.storage.sql; }

  async register(name: string, webhook_url: string | null, webhook_headers: string | null) {
    const id = `agent_${randomToken(12)}`;
    const token = randomToken(32);
    const now = new Date().toISOString();
    this.sql.exec("INSERT INTO agents (id,name,webhook_url,webhook_headers,created_at) VALUES (?,?,?,?,?)", id, name, webhook_url, webhook_headers, now);
    this.sql.exec("INSERT INTO tokens (hash,agent_id,created_at) VALUES (?,?,?)", await sha256Hex(token), id, now);
    return { agent: this.get(id)!, token };
  }

  /** Idempotent import of a legacy room member as a global identity (same id, same token hash). */
  importAgent(a: { id: string; name: string; token_hash: string; webhook_url: string | null; webhook_headers: string | null; created_at: string }, room_id: string) {
    const exists = this.get(a.id);
    if (!exists) {
      this.sql.exec("INSERT INTO agents (id,name,webhook_url,webhook_headers,created_at) VALUES (?,?,?,?,?)", a.id, a.name, a.webhook_url, a.webhook_headers, a.created_at);
    }
    this.sql.exec("INSERT OR IGNORE INTO tokens (hash,agent_id,created_at) VALUES (?,?,?)", a.token_hash, a.id, new Date().toISOString());
    this.addMembership(a.id, room_id);
    return { id: a.id, created: !exists };
  }

  get(id: string): GlobalAgent | null {
    return this.sql.exec<GlobalAgent>("SELECT id,name,webhook_url,webhook_headers,created_at FROM agents WHERE id = ?", id).toArray()[0] ?? null;
  }

  async resolve(token: string): Promise<GlobalAgent | null> {
    const hash = await sha256Hex(token);
    const r = this.sql.exec<{ agent_id: string }>("SELECT agent_id FROM tokens WHERE hash = ?", hash).toArray()[0];
    return r ? this.get(r.agent_id) : null;
  }

  update(id: string, patch: { name?: string; webhook_url?: string | null; webhook_headers?: string | null }) {
    const a = this.get(id);
    if (!a) return null;
    const next = { ...a, ...patch };
    this.sql.exec("UPDATE agents SET name=?, webhook_url=?, webhook_headers=? WHERE id=?", next.name, next.webhook_url, next.webhook_headers, id);
    return this.get(id);
  }

  async rotateToken(id: string) {
    const token = randomToken(32);
    this.sql.exec("DELETE FROM tokens WHERE agent_id = ?", id);
    this.sql.exec("INSERT INTO tokens (hash,agent_id,created_at) VALUES (?,?,?)", await sha256Hex(token), id, new Date().toISOString());
    return token;
  }

  webhooks(ids: string[]): Record<string, { webhook_url: string | null; webhook_headers: string | null }> {
    const out: Record<string, { webhook_url: string | null; webhook_headers: string | null }> = {};
    for (const id of ids) {
      const a = this.get(id);
      if (a) out[id] = { webhook_url: a.webhook_url, webhook_headers: a.webhook_headers };
    }
    return out;
  }

  /** Removes the identity, all its tokens and memberships. Rooms are cleaned up by the caller first. */
  deleteAgent(id: string) {
    this.sql.exec("DELETE FROM tokens WHERE agent_id = ?", id);
    this.sql.exec("DELETE FROM memberships WHERE agent_id = ?", id);
    this.sql.exec("DELETE FROM agents WHERE id = ?", id);
  }

  listAgents() {
    return this.sql.exec<{ id: string; name: string; created_at: string; rooms: number }>(
      "SELECT a.id, a.name, a.created_at, (SELECT COUNT(*) FROM memberships m WHERE m.agent_id = a.id) AS rooms FROM agents a ORDER BY a.created_at ASC"
    ).toArray();
  }

  addMembership(agent_id: string, room_id: string) {
    this.sql.exec("INSERT OR IGNORE INTO memberships (agent_id,room_id,joined_at) VALUES (?,?,?)", agent_id, room_id, new Date().toISOString());
  }
  removeMembership(agent_id: string, room_id: string) {
    this.sql.exec("DELETE FROM memberships WHERE agent_id = ? AND room_id = ?", agent_id, room_id);
  }
  dropRoom(room_id: string) {
    this.sql.exec("DELETE FROM memberships WHERE room_id = ?", room_id);
    this.sql.exec("DELETE FROM invites WHERE room_id = ?", room_id);
  }
  rooms(agent_id: string) {
    return this.sql.exec<{ room_id: string; joined_at: string }>("SELECT room_id, joined_at FROM memberships WHERE agent_id = ? ORDER BY joined_at ASC", agent_id).toArray();
  }

  async createInvite(room_id: string, created_by: string | null, uses: number, ttlSeconds: number) {
    const code = `inv_${randomToken(16)}`;
    const now = Date.now();
    const expires_at = new Date(now + ttlSeconds * 1000).toISOString();
    this.sql.exec("INSERT INTO invites (hash,room_id,created_by,uses_left,expires_at,created_at) VALUES (?,?,?,?,?,?)", await sha256Hex(code), room_id, created_by, uses, expires_at, new Date(now).toISOString());
    return { code, room_id, uses, expires_at };
  }

  /** Consumes one use; returns the room id or null. */
  async redeemInvite(code: string): Promise<string | null> {
    const hash = await sha256Hex(code);
    const r = this.sql.exec<{ room_id: string; uses_left: number; expires_at: string }>("SELECT room_id, uses_left, expires_at FROM invites WHERE hash = ?", hash).toArray()[0];
    if (!r) return null;
    if (r.uses_left < 1 || r.expires_at < new Date().toISOString()) {
      this.sql.exec("DELETE FROM invites WHERE hash = ?", hash);
      return null;
    }
    if (r.uses_left <= 1) this.sql.exec("DELETE FROM invites WHERE hash = ?", hash);
    else this.sql.exec("UPDATE invites SET uses_left = uses_left - 1 WHERE hash = ?", hash);
    return r.room_id;
  }
}
