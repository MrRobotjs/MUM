-- Fresh runtime invitations store only a SHA-256 digest in invites.token.
CREATE TABLE invitation_grants (
    invite_id INTEGER NOT NULL REFERENCES invites(id),
    server_id INTEGER NOT NULL REFERENCES media_servers(id),
    all_libraries INTEGER NOT NULL CHECK (all_libraries IN (0,1)),
    library_ids TEXT NOT NULL CHECK (json_valid(library_ids) AND json_type(library_ids)='array'),
    allow_downloads INTEGER NOT NULL CHECK (allow_downloads IN (0,1)),
    PRIMARY KEY(invite_id,server_id)
);
ALTER TABLE provisioning_jobs ADD COLUMN request_hash TEXT;
ALTER TABLE provisioning_jobs ADD COLUMN reservation_held INTEGER NOT NULL DEFAULT 0 CHECK (reservation_held IN (0,1));
ALTER TABLE provisioning_jobs ADD COLUMN error_code TEXT;
CREATE UNIQUE INDEX provisioning_request ON provisioning_jobs(invite_id,request_hash) WHERE request_hash IS NOT NULL;
CREATE INDEX provisioning_reservations ON provisioning_jobs(invite_id,reservation_held);
ALTER TABLE provisioning_steps ADD COLUMN remote_id TEXT;
ALTER TABLE provisioning_steps ADD COLUMN stage TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE provisioning_steps ADD COLUMN error_code TEXT;
ALTER TABLE provisioning_steps ADD COLUMN grant_snapshot TEXT CHECK (grant_snapshot IS NULL OR json_valid(grant_snapshot));
ALTER TABLE provisioning_steps ADD COLUMN server_revision INTEGER;
