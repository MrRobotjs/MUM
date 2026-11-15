-- Sign in with a media server login. Attempts are kept only for rate limits:
-- hashed source address and username, never the password.
CREATE TABLE service_login_attempts (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 source_hash TEXT NOT NULL,
 server_id INTEGER NOT NULL,
 username_hash TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE INDEX service_login_attempts_created ON service_login_attempts(created_at);

-- How each session was signed in. Service and Plex-connection sessions are
-- rechecked against the sign-in settings and their link on every use.
ALTER TABLE app_sessions ADD COLUMN sign_in_origin TEXT NOT NULL DEFAULT 'password' CHECK(sign_in_origin IN ('password','service','plex_connection'));
ALTER TABLE app_sessions ADD COLUMN via_service_uuid TEXT REFERENCES service_accounts(uuid) ON DELETE CASCADE;
ALTER TABLE app_sessions ADD COLUMN via_plex_connection TEXT;

-- A service account belongs to at most one MUM account. A database that
-- already has two owners for one service account fails here rather than
-- having one silently chosen.
CREATE UNIQUE INDEX service_links_one_owner ON service_links(service_uuid) WHERE link_kind='owner';
