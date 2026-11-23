CREATE TABLE "media_servers_new" (
    "id" INTEGER PRIMARY KEY NOT NULL,
    "server_nickname" TEXT NOT NULL,
    "server_name" TEXT,
    "service_type" TEXT NOT NULL CHECK ("service_type" IN ('plex','jellyfin','emby','kavita','audiobookshelf','komga','romm')),
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
DROP TABLE media_servers;
ALTER TABLE media_servers_new RENAME TO media_servers;
CREATE UNIQUE INDEX media_servers_provider_nickname ON media_servers(service_type,server_nickname);
