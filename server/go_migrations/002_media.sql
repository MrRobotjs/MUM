-- Source column names are retained for compatibility serializers and offline import.

CREATE TABLE "invite_servers" (
    "invite_id" INTEGER NOT NULL REFERENCES "invites"("id"),
    "server_id" INTEGER NOT NULL REFERENCES "media_servers"("id"),
    PRIMARY KEY ("invite_id", "server_id")
);

CREATE TABLE "invite_server_features" (
    "id" INTEGER PRIMARY KEY NOT NULL,
    "invite_id" INTEGER NOT NULL REFERENCES "invites"("id"),
    "server_id" INTEGER NOT NULL REFERENCES "media_servers"("id"),
    "allow_downloads" INTEGER CHECK ("allow_downloads" IN (0,1)),
    "invite_to_plex_home" INTEGER CHECK ("invite_to_plex_home" IN (0,1)),
    "allow_live_tv" INTEGER CHECK ("allow_live_tv" IN (0,1)),
    "allow_4k_transcode" INTEGER CHECK ("allow_4k_transcode" IN (0,1)),
    "created_at" TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    "updated_at" TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE ("invite_id", "server_id")
);

CREATE TABLE "settings" (
    "id" INTEGER PRIMARY KEY NOT NULL,
    "key" TEXT NOT NULL UNIQUE,
    "value" TEXT,
    "value_type" TEXT NOT NULL DEFAULT 'string' CHECK ("value_type" IN ('string','integer','boolean','json','secret')),
    "name" TEXT,
    "description" TEXT,
    "is_public" INTEGER DEFAULT 0 CHECK ("is_public" IN (0,1)),
    "created_at" TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    "updated_at" TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE "invites" (
    "id" INTEGER PRIMARY KEY NOT NULL,
    "token" TEXT NOT NULL UNIQUE,
    "custom_path" TEXT UNIQUE,
    "expires_at" TEXT,
    "max_uses" INTEGER,
    "current_uses" INTEGER NOT NULL DEFAULT 0,
    "grant_library_ids" TEXT DEFAULT '[]' CHECK ("grant_library_ids" IS NULL OR json_valid("grant_library_ids")),
    "allow_downloads" INTEGER NOT NULL DEFAULT 0 CHECK ("allow_downloads" IN (0,1)),
    "created_by_owner_id" INTEGER REFERENCES "identities"("id"),
    "created_at" TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    "updated_at" TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    "is_active" INTEGER NOT NULL DEFAULT 1 CHECK ("is_active" IN (0,1)),
    "membership_duration_days" INTEGER,
    "require_discord_auth" INTEGER CHECK ("require_discord_auth" IN (0,1)),
    "require_discord_guild_membership" INTEGER CHECK ("require_discord_guild_membership" IN (0,1)),
    "grant_purge_whitelist" INTEGER DEFAULT 0 CHECK ("grant_purge_whitelist" IN (0,1)),
    "grant_bot_whitelist" INTEGER DEFAULT 0 CHECK ("grant_bot_whitelist" IN (0,1)),
    "invite_to_plex_home" INTEGER DEFAULT 0 CHECK ("invite_to_plex_home" IN (0,1)),
    "allow_live_tv" INTEGER DEFAULT 0 CHECK ("allow_live_tv" IN (0,1)),
    "allow_4k_transcode" INTEGER NOT NULL DEFAULT 1 CHECK ("allow_4k_transcode" IN (0,1))
);

CREATE TABLE "invite_usages" (
    "id" INTEGER PRIMARY KEY NOT NULL,
    "invite_id" INTEGER NOT NULL REFERENCES "invites"("id"),
    "used_at" TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    "ip_address" TEXT,
    "plex_user_uuid" TEXT,
    "plex_username" TEXT,
    "plex_email" TEXT,
    "plex_thumb" TEXT,
    "plex_auth_successful" INTEGER NOT NULL DEFAULT 0 CHECK ("plex_auth_successful" IN (0,1)),
    "discord_user_id" TEXT,
    "discord_username" TEXT,
    "discord_auth_successful" INTEGER NOT NULL DEFAULT 0 CHECK ("discord_auth_successful" IN (0,1)),
    "userId" TEXT REFERENCES "identities"("uuid"),
    "accepted_invite" INTEGER NOT NULL DEFAULT 0 CHECK ("accepted_invite" IN (0,1)),
    "status_message" TEXT
);

CREATE TABLE "notifications" (
    "id" INTEGER PRIMARY KEY NOT NULL,
    "timestamp" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    "notification_type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "read" INTEGER NOT NULL DEFAULT 0 CHECK ("read" IN (0,1)),
    "details" TEXT CHECK ("details" IS NULL OR json_valid("details")),
    "owner_id" INTEGER REFERENCES "identities"("id"),
    "server_id" INTEGER REFERENCES "media_servers"("id"),
    "invite_id" INTEGER REFERENCES "invites"("id")
);

CREATE TABLE "user_preferences" (
    "id" INTEGER PRIMARY KEY NOT NULL,
    "owner_id" INTEGER NOT NULL UNIQUE REFERENCES "identities"("id"),
    "timezone_preference" TEXT NOT NULL DEFAULT 'local',
    "local_timezone" TEXT,
    "time_format" TEXT NOT NULL DEFAULT '12'
);

CREATE TABLE "media_servers" (
    "id" INTEGER PRIMARY KEY NOT NULL,
    "server_nickname" TEXT NOT NULL UNIQUE,
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
    "last_version" TEXT
);

CREATE TABLE "media_libraries" (
    "id" INTEGER PRIMARY KEY NOT NULL,
    "internal_id" TEXT UNIQUE,
    "server_id" INTEGER NOT NULL REFERENCES "media_servers"("id"),
    "external_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "library_type" TEXT,
    "item_count" INTEGER,
    "last_scanned" TEXT,
    "created_at" TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    "updated_at" TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE ("server_id", "external_id")
);

CREATE TABLE "media_items" (
    "id" INTEGER PRIMARY KEY NOT NULL,
    "library_id" INTEGER NOT NULL REFERENCES "media_libraries"("id"),
    "server_id" INTEGER NOT NULL REFERENCES "media_servers"("id"),
    "external_id" TEXT NOT NULL,
    "parent_id" TEXT,
    "rating_key" TEXT,
    "title" TEXT NOT NULL,
    "sort_title" TEXT,
    "item_type" TEXT NOT NULL,
    "summary" TEXT,
    "year" INTEGER,
    "rating" REAL,
    "duration" INTEGER,
    "season_number" INTEGER,
    "episode_number" INTEGER,
    "file_path" TEXT,
    "file_size" INTEGER,
    "thumb_path" TEXT,
    "art_path" TEXT,
    "added_at" TEXT,
    "updated_at" TEXT,
    "last_synced" TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    "extra_metadata" TEXT CHECK ("extra_metadata" IS NULL OR json_valid("extra_metadata")),
    UNIQUE ("library_id", "external_id")
);

CREATE TABLE "media_stream_history" (
    "id" INTEGER PRIMARY KEY NOT NULL,
    "user_uuid" TEXT REFERENCES "identities"("uuid"),
    "server_id" INTEGER NOT NULL REFERENCES "media_servers"("id"),
    "session_key" TEXT,
    "external_session_id" TEXT,
    "rating_key" TEXT,
    "started_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    "stopped_at" TEXT,
    "duration_seconds" INTEGER,
    "platform" TEXT,
    "product" TEXT,
    "player" TEXT,
    "ip_address" TEXT,
    "is_lan" INTEGER DEFAULT 0 CHECK ("is_lan" IN (0,1)),
    "media_title" TEXT,
    "media_type" TEXT,
    "grandparent_title" TEXT,
    "parent_title" TEXT,
    "library_name" TEXT,
    "external_media_item_id" TEXT,
    "thumb_url" TEXT,
    "media_duration_seconds" INTEGER,
    "view_offset_at_end_seconds" INTEGER,
    "service_data" TEXT DEFAULT '{}' CHECK ("service_data" IS NULL OR json_valid("service_data"))
);

CREATE TABLE "plugins" (
    "id" INTEGER PRIMARY KEY NOT NULL,
    "plugin_id" TEXT NOT NULL UNIQUE,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "version" TEXT NOT NULL,
    "plugin_type" TEXT NOT NULL DEFAULT 'core' CHECK ("plugin_type" IN ('core','official','community','custom')),
    "status" TEXT NOT NULL DEFAULT 'disabled' CHECK ("status" IN ('disabled','enabled','error','installing','updating')),
    "enabled_by_user" INTEGER NOT NULL DEFAULT 0 CHECK ("enabled_by_user" IN (0,1)),
    "author" TEXT,
    "homepage" TEXT,
    "repository" TEXT,
    "license" TEXT,
    "module_path" TEXT NOT NULL,
    "entry_class" TEXT NOT NULL,
    "config_schema" TEXT DEFAULT '{}' CHECK ("config_schema" IS NULL OR json_valid("config_schema")),
    "default_config" TEXT DEFAULT '{}' CHECK ("default_config" IS NULL OR json_valid("default_config")),
    "min_mum_version" TEXT,
    "max_mum_version" TEXT,
    "python_requirements" TEXT DEFAULT '[]' CHECK ("python_requirements" IS NULL OR json_valid("python_requirements")),
    "manifest_policy" TEXT DEFAULT '{}' CHECK ("manifest_policy" IS NULL OR json_valid("manifest_policy")),
    "manifest_integrations" TEXT DEFAULT '{}' CHECK ("manifest_integrations" IS NULL OR json_valid("manifest_integrations")),
    "installed_at" TEXT,
    "last_updated" TEXT,
    "last_error" TEXT,
    "servers_count" INTEGER DEFAULT 0,
    "created_at" TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    "updated_at" TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE "plugin_repositories" (
    "id" INTEGER PRIMARY KEY NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "description" TEXT,
    "is_enabled" INTEGER NOT NULL DEFAULT 1 CHECK ("is_enabled" IN (0,1)),
    "is_official" INTEGER NOT NULL DEFAULT 0 CHECK ("is_official" IN (0,1)),
    "auth_type" TEXT,
    "auth_data" TEXT,
    "last_sync" TEXT,
    "last_error" TEXT,
    "created_at" TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    "updated_at" TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE "overseerr_user_links" (
    "id" INTEGER PRIMARY KEY NOT NULL,
    "plex_user_id" TEXT NOT NULL,
    "plex_username" TEXT NOT NULL,
    "plex_email" TEXT,
    "overseerr_user_id" INTEGER,
    "overseerr_username" TEXT,
    "overseerr_email" TEXT,
    "server_id" INTEGER NOT NULL REFERENCES "media_servers"("id"),
    "is_linked" INTEGER NOT NULL DEFAULT 0 CHECK ("is_linked" IN (0,1)),
    "last_sync_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    "updated_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE "token_blocklist" (
    "id" INTEGER PRIMARY KEY NOT NULL,
    "jti" TEXT NOT NULL UNIQUE,
    "token_type" TEXT NOT NULL,
    "user_uuid" TEXT,
    "revoked_at" TEXT NOT NULL,
    "expires_at" TEXT
);

CREATE INDEX history_user_time ON media_stream_history(user_uuid, started_at);

CREATE INDEX history_server_time ON media_stream_history(server_id, started_at);

CREATE INDEX history_server_media ON media_stream_history(server_id, external_media_item_id);

CREATE INDEX media_library_type_parent ON media_items(library_id, item_type, parent_id);

CREATE INDEX media_server_external ON media_items(server_id, external_id);

CREATE INDEX notification_time ON notifications(timestamp);

CREATE INDEX token_expiry ON token_blocklist(expires_at);
