-- Preserve the existing servers and their foreign-key dependants.
CREATE TABLE "media_servers_new" (
    "id" INTEGER PRIMARY KEY NOT NULL,
    "server_nickname" TEXT NOT NULL,
    "server_name" TEXT,
    "service_type" TEXT NOT NULL CHECK ("service_type" IN ('plex','jellyfin','emby','kavita','audiobookshelf','komga','romm','tofa')),
    "url" TEXT NOT NULL,
    "api_key" TEXT,
    "username" TEXT,
    "password" TEXT,
    "public_url" TEXT,
    "overseerr_enabled" INTEGER NOT NULL DEFAULT 0 CHECK ("overseerr_enabled" IN (0,1)),
    "overseerr_url" TEXT,
    "overseerr_api_key" TEXT,
    "config" TEXT DEFAULT '{}' CHECK ("config" IS NULL OR json_valid("config")),
    "is_active" INTEGER NOT NULL DEFAULT 1 CHECK ("is_active" IN (0,1)),
    "created_at" TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    "updated_at" TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    "last_sync_at" TEXT,
    "last_status_check" TEXT,
    "last_status" INTEGER CHECK ("last_status" IN (0,1)),
    "last_status_error" TEXT,
    "last_version" TEXT,
 revision INTEGER NOT NULL DEFAULT 0,
 config_revision INTEGER NOT NULL DEFAULT 1 CHECK(config_revision>0 AND typeof(config_revision)='integer'),
 cache_images INTEGER NOT NULL DEFAULT 1 CHECK(cache_images IN (0,1))
);
INSERT INTO media_servers_new SELECT * FROM media_servers;
DROP TRIGGER provider_config_revision;
DROP TABLE media_servers;
ALTER TABLE media_servers_new RENAME TO media_servers;
CREATE UNIQUE INDEX media_servers_provider_nickname ON media_servers(service_type,server_nickname);
CREATE TRIGGER create_activity_state AFTER INSERT ON media_servers
WHEN NEW.service_type IN ('jellyfin','emby','plex') BEGIN
 INSERT INTO media_activity_state(server_id) VALUES(NEW.id);
END;
CREATE TRIGGER create_server_refresh AFTER INSERT ON media_servers BEGIN
 INSERT INTO server_refresh_settings(server_id) VALUES(NEW.id);
 INSERT INTO server_refresh_schedules(server_id,scope,next_run_at) VALUES(NEW.id,'users',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
 INSERT INTO server_refresh_schedules(server_id,scope,next_run_at) VALUES(NEW.id,'libraries',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER create_server_schedule AFTER INSERT ON media_servers BEGIN
 INSERT INTO server_sync_schedules(server_id) VALUES(NEW.id);
END;
CREATE TRIGGER overseerr_config_change AFTER UPDATE OF overseerr_enabled,overseerr_url,overseerr_api_key ON media_servers
 WHEN OLD.overseerr_enabled IS NOT NEW.overseerr_enabled OR OLD.overseerr_url IS NOT NEW.overseerr_url OR OLD.overseerr_api_key IS NOT NEW.overseerr_api_key
BEGIN
 DELETE FROM overseerr_links WHERE server_id=NEW.id;
 UPDATE overseerr_state SET revision=revision+1,synced_at=NULL,last_result=NULL WHERE server_id=NEW.id;
END;
CREATE TRIGGER overseerr_state_insert AFTER INSERT ON media_servers BEGIN
 INSERT INTO overseerr_state(server_id) VALUES(NEW.id);
END;
CREATE TRIGGER role_selector_server_update AFTER UPDATE OF server_nickname,service_type ON media_servers
WHEN OLD.server_nickname IS NOT NEW.server_nickname OR OLD.service_type IS NOT NEW.service_type BEGIN
    UPDATE user_role_selector_state SET revision=revision+1;
END;
CREATE TRIGGER server_config_revision AFTER UPDATE OF url,api_key,is_active,service_type ON media_servers
 WHEN OLD.url IS NOT NEW.url OR OLD.api_key IS NOT NEW.api_key OR OLD.is_active IS NOT NEW.is_active OR OLD.service_type IS NOT NEW.service_type
BEGIN
 UPDATE media_servers SET config_revision=config_revision+1 WHERE id=NEW.id;
END;
CREATE TRIGGER provider_config_revision AFTER UPDATE OF enabled ON provider_settings
 WHEN OLD.enabled IS NOT NEW.enabled
BEGIN
 UPDATE media_servers SET config_revision=config_revision+1 WHERE service_type=NEW.provider_id;
END;
CREATE TRIGGER image_cache_server_identity_create AFTER INSERT ON media_servers BEGIN
 INSERT INTO image_cache_server_identity(server_id,namespace) VALUES(NEW.id,lower(hex(randomblob(16))));
END;
INSERT INTO provider_settings(provider_id,enabled) VALUES('tofa',0);
