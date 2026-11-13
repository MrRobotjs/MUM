-- Sign in with Plex: anonymous attempts, each bound to the browser that started
-- it (a cookie whose hash is kept) and ending in at most one MUM session, for
-- the account whose active Plex connection matches the verified Plex account.
-- The sealed secret holds only the PIN device; the Plex token is never kept.
CREATE TABLE plex_login_attempts (
 id TEXT PRIMARY KEY,
 browser_hash TEXT NOT NULL,
 source_hash TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('creating','pending','consumed','failed')),
 remember INTEGER NOT NULL DEFAULT 0 CHECK(remember IN (0,1)),
 secret BLOB,
 expires_at TEXT NOT NULL,
 poll_after TEXT NOT NULL,
 operation_token TEXT,
 operation_expires_at TEXT,
 revision INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX plex_login_created ON plex_login_attempts(created_at);
