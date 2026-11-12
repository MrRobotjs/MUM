CREATE TABLE plex_invitation_authorizations (
 id TEXT PRIMARY KEY,
 invite_id INTEGER NOT NULL REFERENCES invites(id),
 invite_digest TEXT NOT NULL,
 invite_revision INTEGER NOT NULL,
 grant_fingerprint TEXT NOT NULL,
 browser_hash TEXT NOT NULL,
 source_hash TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('creating','pending','verified','confirmed','consumed','failed')),
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
CREATE INDEX plex_invitation_proof_admission ON plex_invitation_authorizations(invite_id,created_at);
CREATE INDEX plex_invitation_proof_source ON plex_invitation_authorizations(source_hash,created_at);
CREATE TABLE plex_invitation_credentials (
 job_id TEXT PRIMARY KEY REFERENCES provisioning_jobs(id),
 proof_id TEXT NOT NULL UNIQUE REFERENCES plex_invitation_authorizations(id),
 user_uuid TEXT NOT NULL REFERENCES user_accounts(uuid),
 account_id TEXT NOT NULL,
 secret BLOB,
 status TEXT NOT NULL CHECK(status IN ('active','released')),
 created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX plex_invitation_active_account ON plex_invitation_credentials(account_id) WHERE status='active';
