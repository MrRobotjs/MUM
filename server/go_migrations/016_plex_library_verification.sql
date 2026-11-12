CREATE TABLE plex_library_verifications (
 job_id TEXT NOT NULL,
 server_id INTEGER NOT NULL,
 checkpoint_revision INTEGER NOT NULL,
 job_revision INTEGER NOT NULL,
 credential_revision INTEGER NOT NULL,
 server_revision INTEGER NOT NULL,
 provider_fingerprint TEXT NOT NULL,
 grant_digest TEXT NOT NULL,
 scope TEXT NOT NULL CHECK(scope='accepted_cloud_and_recipient_library_listing'),
 verified_at TEXT NOT NULL,
 valid_until TEXT NOT NULL,
 PRIMARY KEY(job_id,server_id),
 FOREIGN KEY(job_id,server_id) REFERENCES plex_share_checkpoints(job_id,server_id)
);
