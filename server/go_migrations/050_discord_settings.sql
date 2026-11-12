-- Discord OAuth application settings. OAuth can be enabled only with an ID and
-- secret that Discord verified; the secret is write-only in every API.
CREATE TABLE discord_settings(
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0 AND typeof(revision)='integer'),
 oauth_enabled INTEGER NOT NULL DEFAULT 0 CHECK(oauth_enabled IN (0,1)),
 client_id TEXT CHECK(client_id IS NULL OR (length(client_id) BETWEEN 17 AND 20 AND client_id NOT GLOB '*[^0-9]*')),
 client_secret TEXT CHECK(client_secret IS NULL OR length(client_secret) BETWEEN 1 AND 128),
 redirect_uri_invite TEXT CHECK(redirect_uri_invite IS NULL OR length(redirect_uri_invite) BETWEEN 1 AND 512),
 guild_id TEXT CHECK(guild_id IS NULL OR (length(guild_id) BETWEEN 17 AND 20 AND guild_id NOT GLOB '*[^0-9]*')),
 server_invite_url TEXT CHECK(server_invite_url IS NULL OR length(server_invite_url) BETWEEN 1 AND 512),
 verified_at TEXT,
 updated_at TEXT,
 CHECK(oauth_enabled=0 OR (client_id IS NOT NULL AND client_secret IS NOT NULL AND verified_at IS NOT NULL))
);
INSERT INTO discord_settings(singleton) VALUES(1);
