CREATE TABLE plex_job_completions (
 job_id TEXT PRIMARY KEY REFERENCES provisioning_jobs(id),
 server_id INTEGER NOT NULL,
 user_uuid TEXT NOT NULL REFERENCES user_accounts(uuid),
 service_uuid TEXT NOT NULL REFERENCES service_accounts(uuid),
 connection_id TEXT NOT NULL REFERENCES plex_connections(id),
 job_revision INTEGER NOT NULL,
 checkpoint_revision INTEGER NOT NULL,
 verification_scope TEXT NOT NULL CHECK(verification_scope='accepted_cloud_and_recipient_library_listing'),
 verified_at TEXT NOT NULL,
 completed_at TEXT NOT NULL,
 FOREIGN KEY(job_id,server_id) REFERENCES plex_share_checkpoints(job_id,server_id)
);
