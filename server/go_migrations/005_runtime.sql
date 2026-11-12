CREATE TABLE app_sessions (
    id TEXT PRIMARY KEY,
    user_uuid TEXT NOT NULL REFERENCES user_accounts(uuid) ON DELETE CASCADE,
    access_hash TEXT NOT NULL UNIQUE,
    refresh_hash TEXT NOT NULL UNIQUE,
    access_expires_at TEXT NOT NULL,
    refresh_expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX app_sessions_user ON app_sessions(user_uuid);
CREATE TABLE session_access_tokens (
    token_hash TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES app_sessions(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
);
CREATE INDEX session_access_expiry ON session_access_tokens(expires_at);
CREATE TABLE chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_uuid TEXT NOT NULL REFERENCES user_accounts(uuid),
    message TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 4000),
    created_at TEXT NOT NULL
);
