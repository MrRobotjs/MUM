-- A lingering PMS session is not evidence of renewed access after explicit
-- removal. Only a fresh authoritative users sync can admit the identity again.
CREATE TABLE bulk_removed_identities (
 server_id INTEGER NOT NULL REFERENCES media_servers(id) ON DELETE CASCADE,
 external_user_id TEXT NOT NULL,
 operation_id TEXT NOT NULL REFERENCES bulk_operations(id),
 removed_at TEXT NOT NULL,
 PRIMARY KEY(server_id,external_user_id)
);
