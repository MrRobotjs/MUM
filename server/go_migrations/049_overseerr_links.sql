-- Overseerr links are keyed by the recorded Plex service account and the exact
-- Overseerr user ID matched on Plex account ID; usernames never establish a link.
CREATE TABLE overseerr_links(
 service_uuid TEXT PRIMARY KEY REFERENCES service_accounts(uuid) ON DELETE CASCADE,
 server_id INTEGER NOT NULL REFERENCES media_servers(id) ON DELETE CASCADE,
 overseerr_user_id INTEGER NOT NULL CHECK(overseerr_user_id>0 AND typeof(overseerr_user_id)='integer'),
 overseerr_username TEXT CHECK(overseerr_username IS NULL OR length(overseerr_username)<=255),
 overseerr_email TEXT CHECK(overseerr_email IS NULL OR length(overseerr_email)<=320),
 synced_at TEXT NOT NULL,
 UNIQUE(server_id,overseerr_user_id)
);
CREATE TABLE overseerr_state(
 server_id INTEGER PRIMARY KEY REFERENCES media_servers(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0 AND typeof(revision)='integer'),
 synced_at TEXT,
 last_result TEXT CHECK(last_result IS NULL OR last_result IN ('succeeded','failed'))
);
INSERT INTO overseerr_state(server_id) SELECT id FROM media_servers;
CREATE TRIGGER overseerr_state_insert AFTER INSERT ON media_servers BEGIN
 INSERT INTO overseerr_state(server_id) VALUES(NEW.id);
END;
-- Links from a different Overseerr endpoint or key are meaningless: discard them
-- and advance the revision so an in-flight refresh cannot commit stale results.
CREATE TRIGGER overseerr_config_change AFTER UPDATE OF overseerr_enabled,overseerr_url,overseerr_api_key ON media_servers
 WHEN OLD.overseerr_enabled IS NOT NEW.overseerr_enabled OR OLD.overseerr_url IS NOT NEW.overseerr_url OR OLD.overseerr_api_key IS NOT NEW.overseerr_api_key
BEGIN
 DELETE FROM overseerr_links WHERE server_id=NEW.id;
 UPDATE overseerr_state SET revision=revision+1,synced_at=NULL,last_result=NULL WHERE server_id=NEW.id;
END;
