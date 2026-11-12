-- Owner-initiated remote disable of one recorded service account. A row holds
-- at most one session/role-bound operation lease and the last durable outcome.
-- A lease never authorizes replay: interruption becomes 'unknown' and a later
-- explicit operation always inspects the remote account first.
CREATE TABLE service_remote_access(
 service_uuid TEXT PRIMARY KEY REFERENCES service_accounts(uuid) ON DELETE CASCADE,
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0 AND typeof(revision)='integer'),
 state TEXT NOT NULL DEFAULT 'none' CHECK(state IN ('none','running','disabled','absent','failed','unknown')),
 error_code TEXT CHECK(error_code IS NULL OR length(error_code) BETWEEN 1 AND 64),
 checked_at TEXT,
 operation_token TEXT UNIQUE,
 actor_uuid TEXT REFERENCES user_accounts(uuid) ON DELETE CASCADE,
 access_hash TEXT,
 role_revision INTEGER,
 config_revision INTEGER,
 provider_fingerprint TEXT,
 external_user_id TEXT,
 operation_expires_at TEXT,
 CHECK((operation_token IS NOT NULL)=(state='running')),
 CHECK(operation_token IS NULL OR (actor_uuid IS NOT NULL AND access_hash IS NOT NULL AND role_revision IS NOT NULL AND config_revision IS NOT NULL AND provider_fingerprint IS NOT NULL AND external_user_id IS NOT NULL AND operation_expires_at IS NOT NULL)),
 CHECK(operation_token IS NOT NULL OR (actor_uuid IS NULL AND access_hash IS NULL AND role_revision IS NULL AND config_revision IS NULL AND provider_fingerprint IS NULL AND external_user_id IS NULL AND operation_expires_at IS NULL))
);
INSERT INTO service_remote_access(service_uuid) SELECT uuid FROM service_accounts;
CREATE TRIGGER service_remote_access_insert AFTER INSERT ON service_accounts BEGIN
 INSERT INTO service_remote_access(service_uuid) VALUES(NEW.uuid);
END;
