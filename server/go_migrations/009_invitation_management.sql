ALTER TABLE invites ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE invites ADD COLUMN archived_at TEXT;
CREATE TABLE invitation_secrets (
    invite_id INTEGER PRIMARY KEY REFERENCES invites(id),
    ciphertext BLOB NOT NULL
);
