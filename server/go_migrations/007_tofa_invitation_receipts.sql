-- Tofa invite identities are not service-user identities. Persist send intent
-- and the returned invitation separately from account provisioning steps.
CREATE TABLE tofa_invitation_receipts (
 job_id TEXT NOT NULL,
 server_id INTEGER NOT NULL,
 idempotency_key TEXT NOT NULL,
 recipient_email TEXT NOT NULL,
 provider_fingerprint TEXT NOT NULL,
 remote_invite_id TEXT,
 state TEXT NOT NULL CHECK(state IN ('submitting','queued','waiting','invited','joined','failed','revoked','unknown')),
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(job_id,server_id),
 UNIQUE(server_id,idempotency_key),
 FOREIGN KEY(job_id,server_id) REFERENCES provisioning_steps(job_id,server_id) ON DELETE CASCADE
);
