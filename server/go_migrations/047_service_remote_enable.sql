-- Explicit re-enable joins disable: add the 'enabled' outcome and record which
-- operation a lease belongs to. CHECK constraints cannot be altered, so the
-- table is rebuilt in this transaction with every row, revision and outcome kept.
DROP TRIGGER service_remote_access_insert;
CREATE TABLE service_remote_access_next(
 service_uuid TEXT PRIMARY KEY REFERENCES service_accounts(uuid) ON DELETE CASCADE,
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0 AND typeof(revision)='integer'),
 state TEXT NOT NULL DEFAULT 'none' CHECK(state IN ('none','running','disabled','enabled','absent','failed','unknown')),
 error_code TEXT CHECK(error_code IS NULL OR length(error_code) BETWEEN 1 AND 64),
 checked_at TEXT,
 operation_token TEXT UNIQUE,
 operation_kind TEXT CHECK(operation_kind IS NULL OR operation_kind IN ('disable','enable')),
 actor_uuid TEXT REFERENCES user_accounts(uuid) ON DELETE CASCADE,
 access_hash TEXT,
 role_revision INTEGER,
 config_revision INTEGER,
 link_revision INTEGER CHECK(link_revision IS NULL OR (link_revision>0 AND typeof(link_revision)='integer')),
 provider_fingerprint TEXT,
 external_user_id TEXT,
 operation_expires_at TEXT,
 CHECK((operation_token IS NOT NULL)=(state='running')),
 CHECK(operation_token IS NULL OR (operation_kind IS NOT NULL AND actor_uuid IS NOT NULL AND access_hash IS NOT NULL AND role_revision IS NOT NULL AND config_revision IS NOT NULL AND link_revision IS NOT NULL AND provider_fingerprint IS NOT NULL AND external_user_id IS NOT NULL AND operation_expires_at IS NOT NULL)),
 CHECK(operation_token IS NOT NULL OR (operation_kind IS NULL AND actor_uuid IS NULL AND access_hash IS NULL AND role_revision IS NULL AND config_revision IS NULL AND link_revision IS NULL AND provider_fingerprint IS NULL AND external_user_id IS NULL AND operation_expires_at IS NULL))
);
-- A lease from before this migration has no recorded kind or link pin; it is
-- carried over as an unresolved outcome rather than as a live lease.
INSERT INTO service_remote_access_next(service_uuid,revision,state,error_code,checked_at)
 SELECT service_uuid,
  CASE WHEN operation_token IS NULL THEN revision ELSE revision+1 END,
  CASE WHEN operation_token IS NULL THEN state ELSE 'unknown' END,
  CASE WHEN operation_token IS NULL THEN error_code ELSE 'INTERRUPTED_RECONCILIATION_REQUIRED' END,
  checked_at
 FROM service_remote_access;
DROP TABLE service_remote_access;
ALTER TABLE service_remote_access_next RENAME TO service_remote_access;
CREATE TRIGGER service_remote_access_insert AFTER INSERT ON service_accounts BEGIN
 INSERT INTO service_remote_access(service_uuid) VALUES(NEW.uuid);
END;
