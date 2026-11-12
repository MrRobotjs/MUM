CREATE TABLE log_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id INTEGER REFERENCES media_servers(id),
    source TEXT NOT NULL,
    event_key TEXT,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL CHECK (json_valid(payload)),
    occurred_at TEXT NOT NULL,
    received_at TEXT NOT NULL
);
CREATE UNIQUE INDEX log_source_event ON log_entries(source, server_id, event_key) WHERE event_key IS NOT NULL AND server_id IS NOT NULL;
CREATE UNIQUE INDEX log_system_event ON log_entries(source, event_key) WHERE event_key IS NOT NULL AND server_id IS NULL;
CREATE INDEX log_server_time ON log_entries(server_id, occurred_at);

CREATE TABLE audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_uuid TEXT REFERENCES user_accounts(uuid),
    action TEXT NOT NULL,
    details TEXT NOT NULL CHECK (json_valid(details)),
    occurred_at TEXT NOT NULL
);
CREATE TABLE provisioning_jobs (
    id TEXT PRIMARY KEY,
    invite_id INTEGER REFERENCES invites(id),
    user_uuid TEXT REFERENCES user_accounts(uuid),
    status TEXT NOT NULL CHECK (status IN ('pending','running','completed','failed')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE provisioning_steps (
    job_id TEXT NOT NULL REFERENCES provisioning_jobs(id),
    server_id INTEGER NOT NULL REFERENCES media_servers(id),
    status TEXT NOT NULL CHECK (status IN ('pending','running','completed','failed')),
    result TEXT CHECK (result IS NULL OR json_valid(result)),
    PRIMARY KEY (job_id, server_id)
);
CREATE TABLE import_runs (
    id TEXT PRIMARY KEY,
    source_engine TEXT NOT NULL,
    source_revision TEXT,
    source_checksum TEXT NOT NULL,
    report TEXT NOT NULL CHECK (json_valid(report)),
    completed_at TEXT NOT NULL
);
