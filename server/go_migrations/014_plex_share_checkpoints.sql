CREATE TABLE plex_share_checkpoints (
 job_id TEXT NOT NULL,
 server_id INTEGER NOT NULL,
 state TEXT NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','send_uncertain','awaiting_acceptance','access_observed','cancel_uncertain','cancelled')),
 machine_id TEXT NOT NULL DEFAULT '',
 share_id TEXT NOT NULL DEFAULT '',
 sections TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(sections)),
 revision INTEGER NOT NULL DEFAULT 1,
 operation_token TEXT,
 operation_name TEXT CHECK(operation_name IS NULL OR operation_name IN ('send','inspect','cancel')),
 operation_expires_at TEXT,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(job_id,server_id),
 FOREIGN KEY(job_id,server_id) REFERENCES provisioning_steps(job_id,server_id),
 FOREIGN KEY(job_id) REFERENCES plex_invitation_credentials(job_id),
 CHECK((operation_token IS NULL AND operation_name IS NULL AND operation_expires_at IS NULL) OR (operation_token IS NOT NULL AND operation_name IS NOT NULL AND operation_expires_at IS NOT NULL))
);

-- Existing consumed credentials cannot prove that no remote operation happened.
-- Retain them as uncertain, with no inferred machine/share identity or retry.
INSERT INTO plex_share_checkpoints(job_id,server_id,state,updated_at)
 SELECT c.job_id,s.server_id,'send_uncertain',strftime('%Y-%m-%dT%H:%M:%fZ','now')
 FROM plex_invitation_credentials c
 JOIN provisioning_steps s ON s.job_id=c.job_id
 JOIN media_servers m ON m.id=s.server_id
 WHERE c.status='active' AND m.service_type='plex';
