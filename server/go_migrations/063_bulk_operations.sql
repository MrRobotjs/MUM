-- Receipts survive deletion of selected identities. No provider credentials or
-- raw upstream bodies are stored. Running work is reconciled, never replayed.
CREATE TABLE bulk_operations (
 id TEXT PRIMARY KEY,
 actor_uuid TEXT NOT NULL REFERENCES user_accounts(uuid),
 access_hash TEXT NOT NULL,
 request_id TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 action TEXT NOT NULL,
 payload TEXT NOT NULL CHECK(json_valid(payload)),
 targets TEXT NOT NULL CHECK(json_valid(targets)),
 results TEXT NOT NULL CHECK(json_valid(results)),
 warnings TEXT NOT NULL CHECK(json_valid(warnings)),
 effects TEXT NOT NULL CHECK(json_valid(effects)),
 state TEXT NOT NULL CHECK(state IN ('prepared','running','completed','needs_review')),
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
 role_revision INTEGER NOT NULL,
 operation_token TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 UNIQUE(actor_uuid,request_id)
);
CREATE TABLE bulk_source_locks (
 server_id INTEGER PRIMARY KEY REFERENCES media_servers(id),
 operation_id TEXT NOT NULL REFERENCES bulk_operations(id),
 operation_token TEXT NOT NULL
);
CREATE INDEX bulk_operations_actor ON bulk_operations(actor_uuid,created_at);
