import { randomToken, sha256Hex, type GlobalAgent } from './directory';
import type { Env } from './room';
const authCache = new Map<string, { agent: GlobalAgent; until: number }>();
export class D1Directory {
  private db: D1DatabaseSession;
  constructor(db: D1Database, private maxRooms=50, private maxAgents=3000, private maxGlobalRooms=500) { this.db = db.withSession('first-primary'); }
  private stmt(sql: string, ...args: (string | number | null)[]) { return this.db.prepare(sql).bind(...args); }
  async get(id: string): Promise<GlobalAgent | null> { return this.stmt("SELECT a.*,(SELECT json_group_array(room_id) FROM webhook_pauses WHERE agent_id=a.id) AS paused_rooms FROM agents a WHERE id=?", id).first<GlobalAgent>(); }
  async register(name: string, webhook_url: string | null, webhook_headers: string | null) {
    const id = `agent_${randomToken(12)}`, token = randomToken(), now = new Date().toISOString();
    await this.db.batch([
      this.stmt("INSERT INTO agents(id,name,webhook_url,webhook_headers,created_at) SELECT ?,?,?,?,? WHERE (SELECT n FROM capacity WHERE kind='agents')<?", id,name,webhook_url,webhook_headers,now,this.maxAgents),
      this.stmt('INSERT INTO tokens SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM agents WHERE id=?)', await sha256Hex(token),id,now,id),
    ]);
    const agent=await this.get(id); if(!agent) throw new Error('global identity limit');
    return { agent, token };
  }
  async resolve(token: string): Promise<GlobalAgent | null> {
    const hash = await sha256Hex(token), cached = authCache.get(hash);
    // Cache hits do no I/O. Other isolates stop accepting revoked tokens within 15 seconds.
    if (cached && cached.until > Date.now()) {
      return cached.agent;
    }
    const agent = await this.stmt('SELECT a.* FROM agents a JOIN tokens t ON t.agent_id=a.id WHERE t.hash=?', hash).first<GlobalAgent>();
    if (agent) {
      if (authCache.size >= 2048) authCache.clear();
      authCache.set(hash, { agent, until: Date.now()+15000 });
    }
    return agent;
  }
  private invalidate(id: string) { for (const [key,v] of authCache) if(v.agent.id===id) authCache.delete(key); }
  async update(id: string, patch: { name?: string; webhook_url?: string | null; webhook_headers?: string | null }) {
    const a = await this.get(id); if (!a) return null;
    const next = {...a,...patch};
    const reset = 'webhook_url' in patch || 'webhook_headers' in patch;
    await this.stmt(`UPDATE agents SET name=?,webhook_url=?,webhook_headers=?${reset ? ',webhook_paused=0,webhook_failures=0,webhook_version=?' : ''} WHERE id=?`,
      next.name,next.webhook_url,next.webhook_headers,...(reset ? [randomToken(8)] : []),id).run();
    this.invalidate(id); return this.get(id);
  }
  async rotateToken(id: string) {
    const token = randomToken();
    await this.db.batch([this.stmt('DELETE FROM tokens WHERE agent_id=?',id),this.stmt('INSERT INTO tokens VALUES(?,?,?)',await sha256Hex(token),id,new Date().toISOString())]);
    this.invalidate(id); return token;
  }
  async importAgent(a: {id:string;name:string;token_hash:string;webhook_url:string|null;webhook_headers:string|null;created_at:string}, room: string) {
    const result=await this.db.batch([
      this.stmt("INSERT OR IGNORE INTO agents(id,name,webhook_url,webhook_headers,created_at) SELECT ?,?,?,?,? WHERE (SELECT n FROM capacity WHERE kind='agents')<? AND NOT EXISTS(SELECT 1 FROM identity_imports WHERE id=?)",a.id,a.name,a.webhook_url,a.webhook_headers,a.created_at,this.maxAgents,a.id),
      // Only the identity inserted in this transaction may receive the legacy hash.
      this.stmt('INSERT OR IGNORE INTO tokens SELECT ?,?,? WHERE changes()=1',a.token_hash,a.id,a.created_at),
      this.stmt('INSERT OR IGNORE INTO identity_imports SELECT id FROM agents WHERE id=?',a.id),
    ]);
    if(!await this.get(a.id)) {
      if(await this.stmt('SELECT 1 FROM identity_imports WHERE id=?',a.id).first()) return {id:a.id,created:false};
      throw new Error('global identity limit');
    }
    await this.addMembership(a.id,room); return {id:a.id,created:result[0].meta.changes>0};
  }
  async webhooks(ids: string[]) {
    const out: Record<string, GlobalAgent> = {};
    if (ids.length) for (const a of (await this.stmt(`SELECT * FROM agents WHERE id IN (${ids.map(()=>'?').join(',')})`,...ids).all<GlobalAgent>()).results) out[a.id]=a;
    return out;
  }
  async webhookResult(id: string, version: string, success: boolean, threshold: number) {
    await this.stmt('UPDATE agents SET webhook_failures=CASE WHEN ? THEN 0 ELSE webhook_failures+1 END WHERE id=? AND webhook_version=?',success?1:0,id,version).run();
    await this.stmt('UPDATE agents SET webhook_paused=1 WHERE id=? AND webhook_failures>=?',id,threshold).run();
    this.invalidate(id); return this.get(id);
  }
  async deleteAgent(id: string) {
    await this.db.batch([this.stmt('INSERT OR IGNORE INTO identity_imports VALUES(?)',id),...['tokens','memberships','webhook_pauses','agents'].map(t=>this.stmt(`DELETE FROM ${t} WHERE ${t==='agents'?'id':'agent_id'}=?`,id))]);
    this.invalidate(id);
  }
  async listAgents() { return (await this.stmt('SELECT a.id,a.name,a.created_at,(SELECT COUNT(*) FROM memberships m WHERE m.agent_id=a.id) AS rooms FROM agents a ORDER BY a.created_at').all()).results; }
  async addMembership(id: string, room: string) {
    await this.stmt('INSERT OR IGNORE INTO memberships SELECT ?,?,? WHERE (SELECT COUNT(*) FROM memberships WHERE agent_id=?)<? AND EXISTS(SELECT 1 FROM agents WHERE id=?)',id,room,new Date().toISOString(),id,this.maxRooms,id).run();
    if(!await this.stmt('SELECT 1 FROM memberships WHERE agent_id=? AND room_id=?',id,room).first()) throw new Error('room membership limit');
  }
  async removeMembership(id: string, room: string) { await this.stmt('DELETE FROM memberships WHERE agent_id=? AND room_id=?',id,room).run(); }
  async roomExists(room:string) {return !!await this.stmt('SELECT 1 FROM rooms WHERE room_id=?',room).first();}
  async reserveRoom(room:string) {
    await this.stmt("INSERT OR IGNORE INTO rooms SELECT ?,? WHERE (SELECT n FROM capacity WHERE kind='rooms')<?",room,new Date().toISOString(),this.maxGlobalRooms).run();
    if(!await this.stmt('SELECT 1 FROM rooms WHERE room_id=?',room).first()) throw new Error('global room limit');
  }
  async dropRoom(room: string) { await this.db.batch([this.stmt('DELETE FROM rooms WHERE room_id=?',room),this.stmt('DELETE FROM webhook_pauses WHERE room_id=?',room),this.stmt('DELETE FROM memberships WHERE room_id=?',room),this.stmt('DELETE FROM invites WHERE room_id=?',room)]); }
  async rooms(id: string) { return (await this.stmt('SELECT room_id,joined_at FROM memberships WHERE agent_id=? ORDER BY joined_at',id).all<{room_id:string;joined_at:string}>()).results; }
  async setRoomPaused(id:string,room:string,paused:boolean) {
    await (paused?this.stmt('INSERT OR IGNORE INTO webhook_pauses VALUES(?,?)',id,room):this.stmt('DELETE FROM webhook_pauses WHERE agent_id=? AND room_id=?',id,room)).run();
  }
  async createInvite(room: string, by: string|null, uses: number, ttl: number) {
    await this.stmt('DELETE FROM invites WHERE room_id=? AND (expires_at<=? OR uses_left<=0)',room,new Date().toISOString()).run();
    if((await this.stmt('SELECT COUNT(*) AS n FROM invites WHERE room_id=?',room).first<{n:number}>())!.n>=50) throw new Error('room invite limit');
    const code=`inv_${randomToken(16)}`, now=new Date().toISOString(), expires_at=new Date(Date.now()+ttl*1000).toISOString();
    await this.stmt('INSERT INTO invites SELECT ?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM invites WHERE room_id=?)<50',await sha256Hex(code),room,by,uses,expires_at,now,code,room).run();
    if(!await this.stmt('SELECT 1 FROM invites WHERE hash=?',await sha256Hex(code)).first()) throw new Error('room invite limit');
    return {code,room_id:room,uses,expires_at};
  }
  async redeemInvite(code: string) {
    const r=await this.stmt('UPDATE invites SET uses_left=uses_left-1 WHERE hash=? AND uses_left>0 AND expires_at>? RETURNING room_id',await sha256Hex(code),new Date().toISOString()).first<{room_id:string}>();
    return r?.room_id ?? null;
  }
  async restoreInvite(code:string) { await this.stmt('UPDATE invites SET uses_left=uses_left+1 WHERE hash=? AND expires_at>?',await sha256Hex(code),new Date().toISOString()).run(); }
  async listInvites(room: string) {
    return (await this.stmt('SELECT COALESCE(code,hash) AS code,room_id,created_by,uses_left,expires_at,created_at FROM invites WHERE room_id=? AND uses_left>0 AND expires_at>?',room,new Date().toISOString()).all()).results;
  }
  async revokeInvite(room:string,code:string) {
    const hash=/^[a-f0-9]{64}$/.test(code)?code:await sha256Hex(code);
    await this.stmt('DELETE FROM invites WHERE room_id=? AND hash=?',room,hash).run();
  }
  async cleanupInvites() { await this.stmt('DELETE FROM invites WHERE expires_at<=? OR uses_left<=0',new Date().toISOString()).run(); }

}
export function directory(env: Env) { return new D1Directory(env.DB, Number(env.MAX_ROOMS)||50,Number(env.MAX_IDENTITIES)||3000,Number(env.MAX_GLOBAL_ROOMS)||500); }
