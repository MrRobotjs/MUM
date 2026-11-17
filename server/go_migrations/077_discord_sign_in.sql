-- Discord setup, linking and sign-in (DISCORD_SIGN_IN_DESIGN.md, user
-- decisions 2026-11-16).

-- Sign in with Discord (off by default; administrators only with the second
-- switch), defaults that pre-tick new invitations, and the name of the Discord
-- server read from its invite link.
ALTER TABLE discord_settings ADD COLUMN sign_in_enabled INTEGER NOT NULL DEFAULT 0 CHECK(sign_in_enabled IN (0,1));
ALTER TABLE discord_settings ADD COLUMN sign_in_admins INTEGER NOT NULL DEFAULT 0 CHECK(sign_in_admins IN (0,1));
ALTER TABLE discord_settings ADD COLUMN default_require_auth INTEGER NOT NULL DEFAULT 0 CHECK(default_require_auth IN (0,1));
ALTER TABLE discord_settings ADD COLUMN default_require_guild INTEGER NOT NULL DEFAULT 0 CHECK(default_require_guild IN (0,1));
ALTER TABLE discord_settings ADD COLUMN guild_name TEXT CHECK(guild_name IS NULL OR length(guild_name) BETWEEN 1 AND 100);

-- One Discord sign-in or link in progress, bound to the browser that started
-- it. Only digests of the OAuth state and the browser secret are stored, and
-- no Discord token is ever kept. A link attempt belongs to one account and the
-- session that started it.
CREATE TABLE discord_auth_attempts(
 id TEXT PRIMARY KEY,
 kind TEXT NOT NULL CHECK(kind IN ('login','link')),
 state_hash TEXT NOT NULL UNIQUE,
 browser_hash TEXT NOT NULL,
 user_uuid TEXT REFERENCES user_accounts(uuid) ON DELETE CASCADE,
 session_id TEXT,
 remember INTEGER NOT NULL DEFAULT 0 CHECK(remember IN (0,1)),
 settings_revision INTEGER NOT NULL CHECK(settings_revision>0),
 status TEXT NOT NULL CHECK(status IN ('pending','exchanging','done','failed')),
 error_code TEXT CHECK(error_code IS NULL OR length(error_code) BETWEEN 1 AND 64),
 created_at TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 CHECK((kind='link')=(user_uuid IS NOT NULL AND session_id IS NOT NULL))
);
CREATE INDEX discord_auth_attempts_expiry ON discord_auth_attempts(expires_at);

-- Sessions gain the "discord" origin. CHECK constraints cannot be altered, so
-- the sessions table and its access tokens are rebuilt in this transaction
-- with every row kept; nobody is signed out.
CREATE TABLE app_sessions_next (
 id TEXT PRIMARY KEY,
 user_uuid TEXT NOT NULL REFERENCES user_accounts(uuid) ON DELETE CASCADE,
 access_hash TEXT NOT NULL UNIQUE,
 refresh_hash TEXT NOT NULL UNIQUE,
 access_expires_at TEXT NOT NULL,
 refresh_expires_at TEXT NOT NULL,
 created_at TEXT NOT NULL,
 sign_in_origin TEXT NOT NULL DEFAULT 'password' CHECK(sign_in_origin IN ('password','service','plex_connection','discord')),
 via_service_uuid TEXT REFERENCES service_accounts(uuid) ON DELETE CASCADE,
 via_plex_connection TEXT,
 via_discord_id TEXT CHECK(via_discord_id IS NULL OR (length(via_discord_id) BETWEEN 17 AND 20 AND via_discord_id NOT GLOB '*[^0-9]*')),
 CHECK((sign_in_origin='discord')=(via_discord_id IS NOT NULL))
);
INSERT INTO app_sessions_next(id,user_uuid,access_hash,refresh_hash,access_expires_at,refresh_expires_at,created_at,sign_in_origin,via_service_uuid,via_plex_connection)
 SELECT id,user_uuid,access_hash,refresh_hash,access_expires_at,refresh_expires_at,created_at,sign_in_origin,via_service_uuid,via_plex_connection FROM app_sessions;
CREATE TABLE session_access_tokens_next (
 token_hash TEXT PRIMARY KEY,
 session_id TEXT NOT NULL REFERENCES app_sessions_next(id) ON DELETE CASCADE,
 expires_at TEXT NOT NULL
);
INSERT INTO session_access_tokens_next(token_hash,session_id,expires_at) SELECT token_hash,session_id,expires_at FROM session_access_tokens;
DROP TABLE session_access_tokens;
DROP TABLE app_sessions;
ALTER TABLE app_sessions_next RENAME TO app_sessions;
ALTER TABLE session_access_tokens_next RENAME TO session_access_tokens;
CREATE INDEX app_sessions_user ON app_sessions(user_uuid);
CREATE INDEX session_access_expiry ON session_access_tokens(expires_at);
