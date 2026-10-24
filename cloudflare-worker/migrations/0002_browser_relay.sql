CREATE TABLE rt_installation (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  extension_origin TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  ticket_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX rt_installation_user ON rt_installation(user_id, revoked_at);
CREATE TABLE rt_relay_ticket (
  token_hash TEXT PRIMARY KEY NOT NULL,
  installation_id TEXT NOT NULL REFERENCES rt_installation(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX rt_relay_ticket_expiry ON rt_relay_ticket(expires_at);
