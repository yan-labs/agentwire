/* Keep import receipts after deletion so legacy room snapshots cannot revive identities. */
CREATE TABLE IF NOT EXISTS identity_imports (id TEXT PRIMARY KEY);
INSERT OR IGNORE INTO identity_imports SELECT id FROM agents;
