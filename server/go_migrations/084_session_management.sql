-- Sign-in session management. last_used_at is when the session last renewed
-- its keys, for the inactivity timeout and the signed-in devices list;
-- user_agent and client_ip describe the device for that list. The refresh key
-- a session replaced last is kept as previous_refresh_hash with rotated_at:
-- presenting it again after a short grace period means someone else holds a
-- copy, and the session is ended.
ALTER TABLE app_sessions ADD COLUMN last_used_at TEXT;
ALTER TABLE app_sessions ADD COLUMN user_agent TEXT CHECK(user_agent IS NULL OR length(user_agent) <= 512);
ALTER TABLE app_sessions ADD COLUMN client_ip TEXT CHECK(client_ip IS NULL OR length(client_ip) <= 64);
ALTER TABLE app_sessions ADD COLUMN previous_refresh_hash TEXT;
ALTER TABLE app_sessions ADD COLUMN rotated_at TEXT;
CREATE UNIQUE INDEX app_sessions_previous_refresh ON app_sessions(previous_refresh_hash) WHERE previous_refresh_hash IS NOT NULL;
UPDATE app_sessions SET last_used_at=created_at;
