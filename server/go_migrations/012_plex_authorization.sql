CREATE TABLE plex_key_metadata (
 id INTEGER PRIMARY KEY CHECK(id=1),
 key_hash TEXT NOT NULL
);
CREATE TABLE plex_authorizations (
 id TEXT PRIMARY KEY,
 owner_uuid TEXT NOT NULL REFERENCES user_accounts(uuid),
 browser_hash TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('creating','pending','verified','consumed','failed')),
 secret BLOB,
 account_id TEXT,
 username TEXT,
 expires_at TEXT NOT NULL,
 poll_after TEXT NOT NULL,
 operation_token TEXT,
 operation_expires_at TEXT,
 revision INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX plex_authorization_owner ON plex_authorizations(owner_uuid,created_at);
CREATE TABLE plex_connections (
 id TEXT PRIMARY KEY,
 owner_uuid TEXT NOT NULL REFERENCES user_accounts(uuid),
 account_id TEXT NOT NULL,
 username TEXT NOT NULL,
 secret BLOB,
 status TEXT NOT NULL CHECK(status IN ('active','revoked')),
 created_at TEXT NOT NULL,
 verified_at TEXT NOT NULL,
 revoked_at TEXT
);
CREATE UNIQUE INDEX plex_active_owner ON plex_connections(owner_uuid) WHERE status='active';
CREATE UNIQUE INDEX plex_active_account ON plex_connections(account_id) WHERE status='active';
