CREATE TABLE IF NOT EXISTS agents (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, webhook_url TEXT, webhook_headers TEXT,
 created_at TEXT NOT NULL, webhook_paused INTEGER NOT NULL DEFAULT 0,
 webhook_failures INTEGER NOT NULL DEFAULT 0, webhook_version TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS tokens (hash TEXT PRIMARY KEY, agent_id TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_tokens_agent ON tokens(agent_id);
CREATE TABLE IF NOT EXISTS memberships (
 agent_id TEXT NOT NULL, room_id TEXT NOT NULL, joined_at TEXT NOT NULL,
 PRIMARY KEY(agent_id,room_id)
);
CREATE INDEX IF NOT EXISTS idx_mem_room ON memberships(room_id);
CREATE TABLE IF NOT EXISTS invites (
 hash TEXT PRIMARY KEY, room_id TEXT NOT NULL, created_by TEXT, uses_left INTEGER NOT NULL,
 expires_at TEXT NOT NULL, created_at TEXT NOT NULL, code TEXT
);
CREATE INDEX IF NOT EXISTS idx_inv_room ON invites(room_id);
CREATE INDEX IF NOT EXISTS idx_inv_expiry ON invites(expires_at);
CREATE TABLE IF NOT EXISTS rooms (room_id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS capacity (kind TEXT PRIMARY KEY, n INTEGER NOT NULL);
INSERT OR IGNORE INTO capacity VALUES('agents',0),('rooms',0);
CREATE TRIGGER IF NOT EXISTS count_agents_add AFTER INSERT ON agents BEGIN UPDATE capacity SET n=n+1 WHERE kind='agents'; END;
CREATE TRIGGER IF NOT EXISTS count_agents_del AFTER DELETE ON agents BEGIN UPDATE capacity SET n=n-1 WHERE kind='agents'; END;
CREATE TRIGGER IF NOT EXISTS count_rooms_add AFTER INSERT ON rooms BEGIN UPDATE capacity SET n=n+1 WHERE kind='rooms'; END;
CREATE TRIGGER IF NOT EXISTS count_rooms_del AFTER DELETE ON rooms BEGIN UPDATE capacity SET n=n-1 WHERE kind='rooms'; END;
CREATE TABLE IF NOT EXISTS webhook_pauses (agent_id TEXT NOT NULL,room_id TEXT NOT NULL,PRIMARY KEY(agent_id,room_id));
