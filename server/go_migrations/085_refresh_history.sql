CREATE TABLE session_refresh_history (
    token_hash TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES app_sessions(id) ON DELETE CASCADE,
    rotated_at TEXT NOT NULL
);
CREATE INDEX session_refresh_history_session ON session_refresh_history(session_id);
INSERT INTO session_refresh_history(token_hash,session_id,rotated_at)
SELECT previous_refresh_hash,id,rotated_at FROM app_sessions
WHERE previous_refresh_hash IS NOT NULL AND rotated_at IS NOT NULL;
