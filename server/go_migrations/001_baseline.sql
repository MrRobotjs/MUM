-- Fresh application schema and built-in defaults.
CREATE TABLE identities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('owner','local','service')),
    UNIQUE (uuid, kind)
);
CREATE TABLE user_accounts (
    uuid TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('owner','local')),
    local_username TEXT COLLATE NOCASE UNIQUE,
    password_hash TEXT,
    email TEXT,
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
    force_password_change INTEGER NOT NULL DEFAULT 0 CHECK (force_password_change IN (0,1)),
    sync_preferences INTEGER NOT NULL DEFAULT 0 CHECK (sync_preferences IN (0,1)),
    user_preferences TEXT CHECK (user_preferences IS NULL OR json_valid(user_preferences)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_login_at TEXT,
    notes TEXT,
    access_expires_at TEXT,
    used_invite_id INTEGER REFERENCES invites(id),
    plex_uuid TEXT,
    plex_username TEXT,
    plex_thumb TEXT,
    discord_user_id TEXT,
    discord_username TEXT,
    discord_avatar_hash TEXT,
    discord_access_token TEXT,
    discord_refresh_token TEXT,
    discord_token_expires_at TEXT,
    discord_email TEXT,
    discord_email_verified INTEGER CHECK (discord_email_verified IN (0,1)),
    legacy_metadata TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(legacy_metadata)), profile_revision INTEGER NOT NULL DEFAULT 1 CHECK(profile_revision > 0), display_preferences TEXT NOT NULL
DEFAULT '{"mode":"device","time_format":"12","time_zone":null}'
CHECK (json_valid(display_preferences)), deleted_at TEXT, deleted_username TEXT,
    FOREIGN KEY (uuid, kind) REFERENCES identities(uuid, kind)
);
CREATE TABLE service_accounts (
    uuid TEXT PRIMARY KEY,
    kind TEXT NOT NULL DEFAULT 'service' CHECK (kind='service'),
    server_id INTEGER NOT NULL REFERENCES media_servers(id),
    external_user_id TEXT,
    external_user_alt_id TEXT,
    external_username TEXT,
    external_email TEXT,
    external_avatar_url TEXT,
    allowed_library_ids TEXT DEFAULT '[]' CHECK (allowed_library_ids IS NULL OR json_valid(allowed_library_ids)),
    allow_downloads INTEGER NOT NULL DEFAULT 0 CHECK (allow_downloads IN (0,1)),
    allow_4k_transcode INTEGER NOT NULL DEFAULT 1 CHECK (allow_4k_transcode IN (0,1)),
    service_settings TEXT DEFAULT '{}' CHECK (service_settings IS NULL OR json_valid(service_settings)),
    user_raw_data TEXT DEFAULT '{}' CHECK (user_raw_data IS NULL OR json_valid(user_raw_data)),
    stream_raw_data TEXT DEFAULT '{}' CHECK (stream_raw_data IS NULL OR json_valid(stream_raw_data)),
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
    is_discord_bot_whitelisted INTEGER NOT NULL DEFAULT 0 CHECK (is_discord_bot_whitelisted IN (0,1)),
    is_purge_whitelisted INTEGER NOT NULL DEFAULT 0 CHECK (is_purge_whitelisted IN (0,1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_activity_at TEXT,
    service_join_date TEXT,
    access_expires_at TEXT,
    used_invite_id INTEGER REFERENCES invites(id),
    overseerr_user_id INTEGER,
    notes TEXT,
    discord_user_id TEXT,
    discord_username TEXT,
    legacy_metadata TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(legacy_metadata)), removed_at TEXT, external_account_id TEXT CHECK(external_account_id IS NULL OR length(external_account_id) BETWEEN 1 AND 255),
    UNIQUE (server_id, external_user_id),
    FOREIGN KEY (uuid, kind) REFERENCES identities(uuid, kind)
);
CREATE TABLE service_links (
    user_uuid TEXT NOT NULL REFERENCES user_accounts(uuid),
    service_uuid TEXT NOT NULL REFERENCES service_accounts(uuid),
    link_kind TEXT NOT NULL CHECK (link_kind IN ('owner','delegate')),
    created_by TEXT REFERENCES user_accounts(uuid),
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_uuid, service_uuid)
);
CREATE TABLE admin_roles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
    color TEXT DEFAULT '#808080',
    icon TEXT,
    badge_style TEXT NOT NULL DEFAULT 'default',
    is_auto_managed INTEGER NOT NULL DEFAULT 0 CHECK (is_auto_managed IN (0,1))
);
CREATE TABLE admin_permissions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT
);
CREATE TABLE admin_role_permissions (
    role_id TEXT NOT NULL REFERENCES admin_roles(id) ON DELETE CASCADE,
    permission_id TEXT NOT NULL REFERENCES admin_permissions(id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_id)
);
CREATE TABLE admin_privileges (
    user_uuid TEXT NOT NULL REFERENCES user_accounts(uuid) ON DELETE CASCADE,
    role_id TEXT NOT NULL REFERENCES admin_roles(id) ON DELETE CASCADE,
    PRIMARY KEY (user_uuid, role_id)
);
CREATE TABLE user_roles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    color TEXT DEFAULT '#808080',
    icon TEXT,
    badge_style TEXT NOT NULL DEFAULT 'default',
    is_auto_managed INTEGER NOT NULL DEFAULT 0 CHECK (is_auto_managed IN (0,1))
);
CREATE TABLE identity_user_roles (
    user_uuid TEXT NOT NULL REFERENCES identities(uuid) ON DELETE CASCADE,
    role_id TEXT NOT NULL REFERENCES user_roles(id) ON DELETE CASCADE,
    PRIMARY KEY (user_uuid, role_id)
);
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
, revision INTEGER NOT NULL DEFAULT 1, archived_at TEXT, archived_custom_path TEXT);
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
    "updated_at" TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), is_available INTEGER NOT NULL DEFAULT 1 CHECK (is_available IN (0,1)), catalogue_revision INTEGER NOT NULL DEFAULT 1 CHECK(catalogue_revision>0 AND typeof(catalogue_revision)='integer'), catalogue_synced_at TEXT, catalogue_item_count INTEGER CHECK(catalogue_item_count IS NULL OR (catalogue_item_count>=0 AND typeof(catalogue_item_count)='integer')),
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
    "extra_metadata" TEXT CHECK ("extra_metadata" IS NULL OR json_valid("extra_metadata")), episode_revision INTEGER NOT NULL DEFAULT 1 CHECK(episode_revision>0 AND typeof(episode_revision)='integer'), episodes_synced_at TEXT, episode_count INTEGER CHECK(episode_count IS NULL OR (episode_count>=0 AND typeof(episode_count)='integer')),
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
CREATE TABLE log_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id INTEGER REFERENCES media_servers(id),
    source TEXT NOT NULL,
    event_key TEXT,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL CHECK (json_valid(payload)),
    occurred_at TEXT NOT NULL,
    received_at TEXT NOT NULL
);
CREATE TABLE audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_uuid TEXT REFERENCES user_accounts(uuid),
    action TEXT NOT NULL,
    details TEXT NOT NULL CHECK (json_valid(details)),
    occurred_at TEXT NOT NULL
);
CREATE TABLE provisioning_jobs (
    id TEXT PRIMARY KEY,
    invite_id INTEGER REFERENCES invites(id),
    user_uuid TEXT REFERENCES user_accounts(uuid),
    status TEXT NOT NULL CHECK (status IN ('pending','running','completed','failed')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
, request_hash TEXT, reservation_held INTEGER NOT NULL DEFAULT 0 CHECK (reservation_held IN (0,1)), error_code TEXT, revision INTEGER NOT NULL DEFAULT 1, requested_username TEXT, resolution TEXT CHECK(resolution IS NULL OR resolution='cancelled'), review_token TEXT, review_error_code TEXT, review_operation TEXT CHECK(review_operation IS NULL OR review_operation='resume'), review_actor_uuid TEXT REFERENCES user_accounts(uuid), review_access_hash TEXT CHECK(review_access_hash IS NULL OR length(review_access_hash)=64), review_role_revision INTEGER CHECK(review_role_revision IS NULL OR (review_role_revision>0 AND typeof(review_role_revision)='integer')));
CREATE TABLE provisioning_steps (
    job_id TEXT NOT NULL REFERENCES provisioning_jobs(id),
    server_id INTEGER NOT NULL REFERENCES media_servers(id),
    status TEXT NOT NULL CHECK (status IN ('pending','running','completed','failed')),
    result TEXT CHECK (result IS NULL OR json_valid(result)), remote_id TEXT, stage TEXT NOT NULL DEFAULT 'pending', error_code TEXT, grant_snapshot TEXT CHECK (grant_snapshot IS NULL OR json_valid(grant_snapshot)), server_revision INTEGER, remote_username TEXT, provider_fingerprint TEXT, cleanup_state TEXT NOT NULL DEFAULT 'pending' CHECK(cleanup_state IN ('pending','running','disabled','absent','not_started','manual','failed','unknown')), cleanup_error_code TEXT, cleanup_checked_at TEXT, resume_state TEXT NOT NULL DEFAULT 'pending' CHECK(resume_state IN ('pending','running','completed','failed','unknown')), resume_error_code TEXT,
    PRIMARY KEY (job_id, server_id)
);
CREATE TABLE import_runs (
    id TEXT PRIMARY KEY,
    source_engine TEXT NOT NULL,
    source_revision TEXT,
    source_checksum TEXT NOT NULL,
    report TEXT NOT NULL CHECK (json_valid(report)),
    completed_at TEXT NOT NULL
);
CREATE TABLE legacy_records (
    source_table TEXT NOT NULL,
    row_number INTEGER NOT NULL,
    record TEXT NOT NULL CHECK (json_valid(record)),
    PRIMARY KEY (source_table, row_number)
);
CREATE TABLE chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_uuid TEXT NOT NULL REFERENCES user_accounts(uuid),
    message TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 4000),
    created_at TEXT NOT NULL
);
CREATE TABLE provider_settings (
    provider_id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1))
);
CREATE TABLE invitation_grants (
    invite_id INTEGER NOT NULL REFERENCES invites(id),
    server_id INTEGER NOT NULL REFERENCES media_servers(id),
    all_libraries INTEGER NOT NULL CHECK (all_libraries IN (0,1)),
    library_ids TEXT NOT NULL CHECK (json_valid(library_ids) AND json_type(library_ids)='array'),
    allow_downloads INTEGER NOT NULL CHECK (allow_downloads IN (0,1)), allow_4k_transcode INTEGER NOT NULL DEFAULT 1 CHECK(allow_4k_transcode IN (0,1)), purge_protected INTEGER NOT NULL DEFAULT 0 CHECK(purge_protected IN (0,1)),
    PRIMARY KEY(invite_id,server_id)
);
CREATE TABLE invitation_secrets (
    invite_id INTEGER PRIMARY KEY REFERENCES invites(id),
    ciphertext BLOB NOT NULL
);
CREATE TABLE plex_key_metadata (
 id INTEGER PRIMARY KEY CHECK(id=1),
 key_hash TEXT NOT NULL
);
CREATE TABLE plex_authorizations (
 id TEXT PRIMARY KEY,
 owner_uuid TEXT NOT NULL REFERENCES user_accounts(uuid),
 browser_hash TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('creating','pending','verified','consumed','failed')),
 secret BLOB,
 account_id TEXT,
 username TEXT,
 expires_at TEXT NOT NULL,
 poll_after TEXT NOT NULL,
 operation_token TEXT,
 operation_expires_at TEXT,
 revision INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE TABLE plex_connections (
 id TEXT PRIMARY KEY,
 owner_uuid TEXT NOT NULL REFERENCES user_accounts(uuid),
 account_id TEXT NOT NULL,
 username TEXT NOT NULL,
 secret BLOB,
 status TEXT NOT NULL CHECK(status IN ('active','revoked')),
 created_at TEXT NOT NULL,
 verified_at TEXT NOT NULL,
 revoked_at TEXT
);
CREATE TABLE plex_invitation_authorizations (
 id TEXT PRIMARY KEY,
 invite_id INTEGER NOT NULL REFERENCES invites(id),
 invite_digest TEXT NOT NULL,
 invite_revision INTEGER NOT NULL,
 grant_fingerprint TEXT NOT NULL,
 browser_hash TEXT NOT NULL,
 source_hash TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('creating','pending','verified','confirmed','consumed','failed')),
 secret BLOB,
 account_id TEXT,
 username TEXT,
 expires_at TEXT NOT NULL,
 poll_after TEXT NOT NULL,
 operation_token TEXT,
 operation_expires_at TEXT,
 revision INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE TABLE plex_invitation_credentials (
 job_id TEXT PRIMARY KEY REFERENCES provisioning_jobs(id),
 proof_id TEXT NOT NULL UNIQUE REFERENCES plex_invitation_authorizations(id),
 user_uuid TEXT NOT NULL REFERENCES user_accounts(uuid),
 account_id TEXT NOT NULL,
 secret BLOB,
 status TEXT NOT NULL CHECK(status IN ('active','released')),
 created_at TEXT NOT NULL
, revision INTEGER NOT NULL DEFAULT 1, refresh_token TEXT, refresh_expires_at TEXT);
CREATE TABLE plex_share_checkpoints (
 job_id TEXT NOT NULL,
 server_id INTEGER NOT NULL,
 state TEXT NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','send_uncertain','awaiting_acceptance','access_observed','cancel_uncertain','cancelled')),
 machine_id TEXT NOT NULL DEFAULT '',
 share_id TEXT NOT NULL DEFAULT '',
 sections TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(sections)),
 revision INTEGER NOT NULL DEFAULT 1,
 operation_token TEXT,
 operation_name TEXT CHECK(operation_name IS NULL OR operation_name IN ('send','inspect','cancel')),
 operation_expires_at TEXT,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(job_id,server_id),
 FOREIGN KEY(job_id,server_id) REFERENCES provisioning_steps(job_id,server_id),
 FOREIGN KEY(job_id) REFERENCES plex_invitation_credentials(job_id),
 CHECK((operation_token IS NULL AND operation_name IS NULL AND operation_expires_at IS NULL) OR (operation_token IS NOT NULL AND operation_name IS NOT NULL AND operation_expires_at IS NOT NULL))
);
CREATE TABLE plex_library_verifications (
 job_id TEXT NOT NULL,
 server_id INTEGER NOT NULL,
 checkpoint_revision INTEGER NOT NULL,
 job_revision INTEGER NOT NULL,
 credential_revision INTEGER NOT NULL,
 server_revision INTEGER NOT NULL,
 provider_fingerprint TEXT NOT NULL,
 grant_digest TEXT NOT NULL,
 scope TEXT NOT NULL CHECK(scope='accepted_cloud_and_recipient_library_listing'),
 verified_at TEXT NOT NULL,
 valid_until TEXT NOT NULL,
 PRIMARY KEY(job_id,server_id),
 FOREIGN KEY(job_id,server_id) REFERENCES plex_share_checkpoints(job_id,server_id)
);
CREATE TABLE plex_job_completions (
 job_id TEXT PRIMARY KEY REFERENCES provisioning_jobs(id),
 server_id INTEGER NOT NULL,
 user_uuid TEXT NOT NULL REFERENCES user_accounts(uuid),
 service_uuid TEXT NOT NULL REFERENCES service_accounts(uuid),
 connection_id TEXT NOT NULL REFERENCES plex_connections(id),
 job_revision INTEGER NOT NULL,
 checkpoint_revision INTEGER NOT NULL,
 verification_scope TEXT NOT NULL CHECK(verification_scope='accepted_cloud_and_recipient_library_listing'),
 verified_at TEXT NOT NULL,
 completed_at TEXT NOT NULL,
 FOREIGN KEY(job_id,server_id) REFERENCES plex_share_checkpoints(job_id,server_id)
);
CREATE TABLE admin_role_state (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    revision INTEGER NOT NULL CHECK(revision>0)
);
CREATE TABLE admin_notification_content(singleton INTEGER PRIMARY KEY CHECK(singleton=1),revision INTEGER NOT NULL CHECK(revision>0));
CREATE TABLE admin_notification_inboxes(user_uuid TEXT PRIMARY KEY REFERENCES user_accounts(uuid) ON DELETE CASCADE,revision INTEGER NOT NULL CHECK(revision>0));
CREATE TABLE server_sync_schedules(
 server_id INTEGER PRIMARY KEY REFERENCES media_servers(id) ON DELETE CASCADE,
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
 interval_seconds INTEGER NOT NULL DEFAULT 3600 CHECK(interval_seconds BETWEEN 60 AND 86400),
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
 authorized_by TEXT REFERENCES user_accounts(uuid),
 next_run_at TEXT,
 run_state TEXT NOT NULL DEFAULT 'idle' CHECK(run_state IN ('idle','running','succeeded','failed','cancelled','interrupted')),
 claim_token TEXT,
 runner_id TEXT,
 lease_until TEXT,
 started_at TEXT,
 finished_at TEXT,
 last_code TEXT NOT NULL DEFAULT 'NEVER_RUN' CHECK(last_code IN ('NEVER_RUN','SUCCEEDED','FAILED','CANCELLED','INTERRUPTED')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
 CHECK((run_state='running' AND claim_token IS NOT NULL AND runner_id IS NOT NULL AND lease_until IS NOT NULL) OR (run_state<>'running' AND claim_token IS NULL AND runner_id IS NULL AND lease_until IS NULL)),
 CHECK(enabled=0 OR (authorized_by IS NOT NULL AND next_run_at IS NOT NULL))
);
CREATE TABLE media_activity_state(
 server_id INTEGER PRIMARY KEY REFERENCES media_servers(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
 generation INTEGER NOT NULL DEFAULT 0 CHECK(generation>=0),
 mapping_revision INTEGER NOT NULL DEFAULT 1 CHECK(mapping_revision>0),
 pending_token TEXT,
 pending_at TEXT,
 pending_until TEXT,
 observed_at TEXT,
 observed_config_revision INTEGER,
 observed_mapping_revision INTEGER,
 last_result TEXT NOT NULL DEFAULT 'never' CHECK(last_result IN ('never','fresh','failed'))
, observed_source TEXT NOT NULL DEFAULT 'http' CHECK(observed_source IN ('http','ws')));
CREATE TABLE media_activity_history(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 server_id INTEGER NOT NULL REFERENCES media_servers(id),
 external_session_id TEXT NOT NULL,
 service_uuid TEXT NOT NULL REFERENCES service_accounts(uuid),
 owner_uuid TEXT REFERENCES user_accounts(uuid),
 item_id TEXT NOT NULL,
 media_type TEXT NOT NULL,
 title TEXT NOT NULL,
 first_seen_at TEXT NOT NULL,
 last_seen_at TEXT NOT NULL,
 ended_at TEXT,
 end_reason TEXT CHECK(end_reason IN ('not_observed','item_changed','identity_changed','ownership_changed')),
 paused INTEGER NOT NULL CHECK(paused IN (0,1)),
 position_ticks INTEGER CHECK(position_ticks>=0),
 duration_ticks INTEGER CHECK(duration_ticks>=0), parent_item_id TEXT CHECK(parent_item_id IS NULL OR length(parent_item_id) BETWEEN 1 AND 256), parent_title TEXT CHECK(parent_title IS NULL OR (parent_item_id IS NOT NULL AND length(parent_title) BETWEEN 1 AND 1024)), client TEXT CHECK(client IS NULL OR length(client) BETWEEN 1 AND 128), device_name TEXT CHECK(device_name IS NULL OR length(device_name) BETWEEN 1 AND 256), play_method TEXT CHECK(play_method IS NULL OR play_method IN ('direct_play','direct_stream','transcode')), poster_item TEXT CHECK(poster_item IS NULL OR length(poster_item) BETWEEN 1 AND 256), poster_path TEXT CHECK(poster_path IS NULL OR (poster_item IS NOT NULL AND length(poster_path) BETWEEN 1 AND 1024)), library_name TEXT CHECK(library_name IS NULL OR length(library_name) BETWEEN 1 AND 1024), paused_seconds INTEGER CHECK(paused_seconds IS NULL OR paused_seconds>=0), platform TEXT CHECK(platform IS NULL OR length(platform) BETWEEN 1 AND 64), ip_address TEXT CHECK(ip_address IS NULL OR length(ip_address) BETWEEN 2 AND 45), paused_since TEXT, source_resolution TEXT CHECK(source_resolution IS NULL OR length(source_resolution) BETWEEN 2 AND 8), stream_resolution TEXT CHECK(stream_resolution IS NULL OR length(stream_resolution) BETWEEN 2 AND 8),
 CHECK((ended_at IS NULL AND end_reason IS NULL) OR (ended_at IS NOT NULL AND end_reason IS NOT NULL)),
 UNIQUE(id,server_id,external_session_id)
);
CREATE TABLE media_activity_current(
 server_id INTEGER NOT NULL REFERENCES media_servers(id),
 external_session_id TEXT NOT NULL,
 history_id INTEGER NOT NULL UNIQUE REFERENCES media_activity_history(id), display_json TEXT NOT NULL DEFAULT '{}'
 CHECK(json_valid(display_json) AND length(display_json)<=16384),
 PRIMARY KEY(server_id,external_session_id),
 FOREIGN KEY(history_id,server_id,external_session_id) REFERENCES media_activity_history(id,server_id,external_session_id)
);
CREATE TABLE account_link_state (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    revision INTEGER NOT NULL CHECK(revision>0 AND typeof(revision)='integer')
);
CREATE TABLE profile_note_state (
    uuid TEXT PRIMARY KEY REFERENCES identities(uuid) ON DELETE CASCADE,
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0 AND typeof(revision)='integer')
);
CREATE TABLE human_activation_state (
    uuid TEXT PRIMARY KEY REFERENCES user_accounts(uuid) ON DELETE CASCADE,
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0 AND typeof(revision)='integer')
);
CREATE TABLE human_expiry_state (
    uuid TEXT PRIMARY KEY REFERENCES user_accounts(uuid) ON DELETE CASCADE,
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0 AND typeof(revision)='integer')
);
CREATE TABLE user_role_state (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0 AND typeof(revision)='integer')
);
CREATE TABLE user_role_selector_state (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0 AND typeof(revision)='integer')
);
CREATE TABLE "download_role_state" (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0 AND typeof(revision)='integer')
);
CREATE TABLE "download_role" (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    role_id TEXT NOT NULL UNIQUE REFERENCES user_roles(id) ON DELETE RESTRICT
);
CREATE TABLE human_credential_state (
    uuid TEXT PRIMARY KEY REFERENCES user_accounts(uuid) ON DELETE CASCADE,
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0 AND typeof(revision)='integer')
);
CREATE TABLE admin_notification_signals (
 scope TEXT PRIMARY KEY,
 revision INTEGER NOT NULL CHECK(revision>0)
);
CREATE TABLE "admin_notifications" (
 id INTEGER PRIMARY KEY AUTOINCREMENT CHECK(id>0 AND id<=9007199254740991),
 notification_type TEXT NOT NULL CHECK(notification_type IN ('SERVER_NOT_SYNCED','ACCOUNT_EXPIRED','SERVICE_EXPIRED')),
 occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 audience TEXT NOT NULL CHECK(audience IN ('administrators','recipient')),
 recipient_uuid TEXT REFERENCES user_accounts(uuid) ON DELETE CASCADE,
 server_id INTEGER REFERENCES media_servers(id) ON DELETE CASCADE,
 subject_uuid TEXT REFERENCES identities(uuid) ON DELETE CASCADE,
 expiry_revision INTEGER,
 resolved INTEGER NOT NULL DEFAULT 0 CHECK(resolved IN (0,1)),
 CHECK((audience='administrators' AND recipient_uuid IS NULL) OR (audience='recipient' AND recipient_uuid IS NOT NULL)),
 CHECK((notification_type='SERVER_NOT_SYNCED' AND server_id IS NOT NULL AND subject_uuid IS NULL AND expiry_revision IS NULL)
 OR (notification_type IN ('ACCOUNT_EXPIRED','SERVICE_EXPIRED') AND audience='recipient' AND server_id IS NULL AND subject_uuid IS NOT NULL AND expiry_revision IS NOT NULL AND expiry_revision>0 AND typeof(expiry_revision)='integer'))
);
CREATE TABLE admin_notification_receipts(
 user_uuid TEXT NOT NULL REFERENCES user_accounts(uuid) ON DELETE CASCADE,
 notification_id INTEGER NOT NULL REFERENCES admin_notifications(id) ON DELETE CASCADE,
 is_read INTEGER NOT NULL DEFAULT 0 CHECK(is_read IN (0,1)),
 dismissed INTEGER NOT NULL DEFAULT 0 CHECK(dismissed IN (0,1)),
 PRIMARY KEY(user_uuid,notification_id)
);
CREATE TABLE service_expiry_state(uuid TEXT PRIMARY KEY REFERENCES service_accounts(uuid) ON DELETE CASCADE,revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0 AND typeof(revision)='integer'));
CREATE TABLE "service_remote_access"(
 service_uuid TEXT PRIMARY KEY REFERENCES service_accounts(uuid) ON DELETE CASCADE,
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0 AND typeof(revision)='integer'),
 state TEXT NOT NULL DEFAULT 'none' CHECK(state IN ('none','running','disabled','enabled','deleted','absent','failed','unknown')),
 error_code TEXT CHECK(error_code IS NULL OR length(error_code) BETWEEN 1 AND 64),
 checked_at TEXT,
 operation_token TEXT UNIQUE,
 operation_kind TEXT CHECK(operation_kind IS NULL OR operation_kind IN ('disable','enable','delete')),
 actor_uuid TEXT REFERENCES user_accounts(uuid) ON DELETE CASCADE,
 access_hash TEXT,
 role_revision INTEGER,
 config_revision INTEGER,
 link_revision INTEGER CHECK(link_revision IS NULL OR (link_revision>0 AND typeof(link_revision)='integer')),
 provider_fingerprint TEXT,
 external_user_id TEXT,
 operation_expires_at TEXT,
 CHECK((operation_token IS NOT NULL)=(state='running')),
 CHECK(operation_token IS NULL OR (operation_kind IS NOT NULL AND actor_uuid IS NOT NULL AND access_hash IS NOT NULL AND role_revision IS NOT NULL AND config_revision IS NOT NULL AND link_revision IS NOT NULL AND provider_fingerprint IS NOT NULL AND external_user_id IS NOT NULL AND operation_expires_at IS NOT NULL)),
 CHECK(operation_token IS NOT NULL OR (operation_kind IS NULL AND actor_uuid IS NULL AND access_hash IS NULL AND role_revision IS NULL AND config_revision IS NULL AND link_revision IS NULL AND provider_fingerprint IS NULL AND external_user_id IS NULL AND operation_expires_at IS NULL))
);
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
 updated_at TEXT, sign_in_enabled INTEGER NOT NULL DEFAULT 0 CHECK(sign_in_enabled IN (0,1)), sign_in_admins INTEGER NOT NULL DEFAULT 0 CHECK(sign_in_admins IN (0,1)), default_require_auth INTEGER NOT NULL DEFAULT 0 CHECK(default_require_auth IN (0,1)), default_require_guild INTEGER NOT NULL DEFAULT 0 CHECK(default_require_guild IN (0,1)), guild_name TEXT CHECK(guild_name IS NULL OR length(guild_name) BETWEEN 1 AND 100),
 CHECK(oauth_enabled=0 OR (client_id IS NOT NULL AND client_secret IS NOT NULL AND verified_at IS NOT NULL))
);
CREATE TABLE invitation_discord_proofs(
 id TEXT PRIMARY KEY,
 invite_id INTEGER NOT NULL REFERENCES invites(id) ON DELETE CASCADE,
 invitation_revision INTEGER NOT NULL CHECK(invitation_revision>0),
 settings_revision INTEGER NOT NULL CHECK(settings_revision>0),
 require_guild INTEGER NOT NULL CHECK(require_guild IN (0,1)),
 state_hash TEXT NOT NULL UNIQUE,
 browser_hash TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','exchanging','verified','consumed','failed')),
 error_code TEXT CHECK(error_code IS NULL OR length(error_code) BETWEEN 1 AND 64),
 discord_user_id TEXT CHECK(discord_user_id IS NULL OR (length(discord_user_id) BETWEEN 17 AND 20 AND discord_user_id NOT GLOB '*[^0-9]*')),
 discord_username TEXT CHECK(discord_username IS NULL OR length(discord_username) BETWEEN 1 AND 64),
 discord_avatar TEXT CHECK(discord_avatar IS NULL OR length(discord_avatar) BETWEEN 1 AND 64),
 guild_verified INTEGER CHECK(guild_verified IS NULL OR guild_verified IN (0,1)),
 job_id TEXT REFERENCES provisioning_jobs(id),
 created_at TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 CHECK(status NOT IN ('verified','consumed') OR (discord_user_id IS NOT NULL AND discord_username IS NOT NULL)),
 CHECK(status<>'verified' OR require_guild=0 OR guild_verified=1),
 CHECK((status='consumed')=(job_id IS NOT NULL))
);
CREATE TABLE media_collections (
    id INTEGER PRIMARY KEY NOT NULL,
    library_id INTEGER NOT NULL REFERENCES media_libraries(id) ON DELETE CASCADE,
    external_id TEXT NOT NULL CHECK(length(external_id) BETWEEN 1 AND 64),
    title TEXT NOT NULL CHECK(length(title)>0),
    sort_title TEXT NOT NULL,
    child_count INTEGER CHECK(child_count IS NULL OR (child_count>=0 AND typeof(child_count)='integer')),
    smart INTEGER NOT NULL DEFAULT 0 CHECK(smart IN (0,1)),
    thumb_path TEXT,
    added_at TEXT,
    last_synced TEXT NOT NULL,
    UNIQUE(library_id, external_id)
);
CREATE TABLE "edit_operations" (
 id TEXT PRIMARY KEY,
 actor_uuid TEXT NOT NULL REFERENCES user_accounts(uuid),
 access_hash TEXT NOT NULL,
 request_id TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 action TEXT NOT NULL,
 payload TEXT NOT NULL CHECK(json_valid(payload)),
 targets TEXT NOT NULL CHECK(json_valid(targets)),
 results TEXT NOT NULL CHECK(json_valid(results)),
 warnings TEXT NOT NULL CHECK(json_valid(warnings)),
 effects TEXT NOT NULL CHECK(json_valid(effects)),
 state TEXT NOT NULL CHECK(state IN ('prepared','running','completed','needs_review')),
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
 role_revision INTEGER NOT NULL,
 operation_token TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 UNIQUE(actor_uuid,request_id)
);
CREATE TABLE "edit_source_locks" (
 server_id INTEGER PRIMARY KEY REFERENCES media_servers(id),
 operation_id TEXT NOT NULL REFERENCES "edit_operations"(id),
 operation_token TEXT NOT NULL
);
CREATE TABLE "edit_removed_identities" (
 server_id INTEGER NOT NULL REFERENCES media_servers(id) ON DELETE CASCADE,
 external_user_id TEXT NOT NULL,
 operation_id TEXT NOT NULL REFERENCES "edit_operations"(id),
 removed_at TEXT NOT NULL,
 PRIMARY KEY(server_id,external_user_id)
);
CREATE TABLE download_observations (
    service_uuid TEXT PRIMARY KEY,
    server_id INTEGER NOT NULL,
    external_user_id TEXT NOT NULL,
    role_id TEXT NOT NULL REFERENCES download_role(role_id) ON DELETE RESTRICT,
    allowed INTEGER NOT NULL CHECK(allowed IN (0,1)),
    source_revision INTEGER NOT NULL CHECK(source_revision>0 AND typeof(source_revision)='integer'),
    observed_at TEXT NOT NULL,
    provider_type TEXT NOT NULL CHECK(provider_type IN ('romm','jellyfin','emby','kavita','audiobookshelf','komga','plex')),
    FOREIGN KEY(service_uuid,server_id,external_user_id)
        REFERENCES service_accounts(uuid,server_id,external_user_id) ON DELETE CASCADE
);
CREATE TABLE relationship_roles (
    kind TEXT PRIMARY KEY CHECK(kind IN ('home_user','shares_back')),
    role_id TEXT NOT NULL UNIQUE REFERENCES user_roles(id) ON DELETE RESTRICT
);
CREATE TABLE plex_login_attempts (
 id TEXT PRIMARY KEY,
 browser_hash TEXT NOT NULL,
 source_hash TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('creating','pending','consumed','failed')),
 remember INTEGER NOT NULL DEFAULT 0 CHECK(remember IN (0,1)),
 secret BLOB,
 expires_at TEXT NOT NULL,
 poll_after TEXT NOT NULL,
 operation_token TEXT,
 operation_expires_at TEXT,
 revision INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE TABLE service_login_attempts (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 source_hash TEXT NOT NULL,
 server_id INTEGER NOT NULL,
 username_hash TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE TABLE transcode_policy_stops (
 history_id INTEGER PRIMARY KEY REFERENCES media_activity_history(id) ON DELETE CASCADE,
 attempted_at TEXT NOT NULL,
 outcome TEXT NOT NULL CHECK(outcome IN ('pending','terminated','already_ended','refused','failed'))
);
CREATE TABLE history_imports (
 server_id INTEGER NOT NULL REFERENCES media_servers(id) ON DELETE CASCADE,
 entry_key TEXT NOT NULL CHECK(length(entry_key) BETWEEN 1 AND 256),
 account_id TEXT NOT NULL CHECK(length(account_id) BETWEEN 1 AND 64),
 viewed_at TEXT NOT NULL,
 media_type TEXT CHECK(media_type IS NULL OR length(media_type) BETWEEN 1 AND 32),
 item_id TEXT CHECK(item_id IS NULL OR length(item_id) BETWEEN 1 AND 256),
 library_id TEXT CHECK(library_id IS NULL OR length(library_id) BETWEEN 1 AND 64),
 title TEXT CHECK(title IS NULL OR length(title) BETWEEN 1 AND 1024),
 parent_title TEXT CHECK(parent_title IS NULL OR length(parent_title) BETWEEN 1 AND 1024),
 grandparent_title TEXT CHECK(grandparent_title IS NULL OR length(grandparent_title) BETWEEN 1 AND 1024),
 poster_item TEXT CHECK(poster_item IS NULL OR length(poster_item) BETWEEN 1 AND 256),
 poster_path TEXT CHECK(poster_path IS NULL OR (poster_item IS NOT NULL AND length(poster_path) BETWEEN 1 AND 1024)),
 position_seconds INTEGER CHECK(position_seconds IS NULL OR position_seconds>=0),
 duration_seconds INTEGER CHECK(duration_seconds IS NULL OR duration_seconds>=0),
 imported_at TEXT NOT NULL, listened_seconds INTEGER CHECK(listened_seconds IS NULL OR listened_seconds>=0),
 PRIMARY KEY(server_id, entry_key)
);
CREATE TABLE history_import_runs (
 server_id INTEGER PRIMARY KEY REFERENCES media_servers(id) ON DELETE CASCADE,
 state TEXT NOT NULL CHECK(state IN ('running','completed','failed','stopped')),
 started_at TEXT NOT NULL,
 finished_at TEXT,
 total INTEGER NOT NULL DEFAULT 0 CHECK(total>=0),
 read_count INTEGER NOT NULL DEFAULT 0 CHECK(read_count>=0),
 added INTEGER NOT NULL DEFAULT 0 CHECK(added>=0),
 already_stored INTEGER NOT NULL DEFAULT 0 CHECK(already_stored>=0),
 already_recorded INTEGER NOT NULL DEFAULT 0 CHECK(already_recorded>=0),
 unknown_accounts INTEGER NOT NULL DEFAULT 0 CHECK(unknown_accounts>=0),
 error_code TEXT CHECK(error_code IS NULL OR length(error_code) BETWEEN 1 AND 64)
, account_id TEXT CHECK(account_id IS NULL OR length(account_id) BETWEEN 1 AND 64));
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
CREATE TABLE "app_sessions" (
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
 via_discord_id TEXT CHECK(via_discord_id IS NULL OR (length(via_discord_id) BETWEEN 17 AND 20 AND via_discord_id NOT GLOB '*[^0-9]*')), last_used_at TEXT, user_agent TEXT CHECK(user_agent IS NULL OR length(user_agent) <= 512), client_ip TEXT CHECK(client_ip IS NULL OR length(client_ip) <= 64), previous_refresh_hash TEXT, rotated_at TEXT, remember_device INTEGER NOT NULL DEFAULT 1 CHECK(remember_device IN (0,1)),
 CHECK((sign_in_origin='discord')=(via_discord_id IS NOT NULL))
);
CREATE TABLE "session_access_tokens" (
 token_hash TEXT PRIMARY KEY,
 session_id TEXT NOT NULL REFERENCES "app_sessions"(id) ON DELETE CASCADE,
 expires_at TEXT NOT NULL
);
CREATE TABLE session_refresh_history (
    token_hash TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES app_sessions(id) ON DELETE CASCADE,
    rotated_at TEXT NOT NULL
);
CREATE TABLE server_refresh_settings (
 server_id INTEGER PRIMARY KEY REFERENCES media_servers(id) ON DELETE CASCADE,
 include_episodes_and_tracks INTEGER NOT NULL DEFAULT 1 CHECK(include_episodes_and_tracks IN (0,1)),
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0)
);
CREATE TABLE server_refresh_schedules (
 server_id INTEGER NOT NULL REFERENCES media_servers(id) ON DELETE CASCADE,
 scope TEXT NOT NULL CHECK(scope IN ('users','libraries')),
 interval_seconds INTEGER NOT NULL DEFAULT 3600 CHECK(interval_seconds BETWEEN 3600 AND 31536000),
 refresh_on_startup INTEGER NOT NULL DEFAULT 1 CHECK(refresh_on_startup IN (0,1)),
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
 next_run_at TEXT,
 run_state TEXT NOT NULL DEFAULT 'idle' CHECK(run_state IN ('idle','running','succeeded','failed','cancelled','interrupted')),
 claim_token TEXT,
 runner_id TEXT,
 lease_until TEXT,
 started_at TEXT,
 finished_at TEXT,
 last_code TEXT NOT NULL DEFAULT 'NEVER_RUN',
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
 PRIMARY KEY(server_id,scope),
 CHECK((run_state='running' AND claim_token IS NOT NULL AND runner_id IS NOT NULL AND lease_until IS NOT NULL) OR (run_state<>'running' AND claim_token IS NULL AND runner_id IS NULL AND lease_until IS NULL))
);
CREATE TABLE "activity_monitor_schedules"(
 server_id INTEGER PRIMARY KEY REFERENCES media_servers(id) ON DELETE CASCADE,
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
 interval_seconds INTEGER NOT NULL DEFAULT 30 CHECK(interval_seconds BETWEEN 15 AND 3600),
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
 configured_server_revision INTEGER,
 authorized_by TEXT REFERENCES user_accounts(uuid),
 next_run_at TEXT,
 run_state TEXT NOT NULL DEFAULT 'idle' CHECK(run_state IN ('idle','running','succeeded','failed','cancelled','interrupted')),
 claim_token TEXT,
 runner_id TEXT,
 lease_until TEXT,
 started_at TEXT,
 finished_at TEXT,
 last_code TEXT NOT NULL DEFAULT 'NEVER_RUN',
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
 socket_enabled INTEGER NOT NULL DEFAULT 0 CHECK(socket_enabled IN (0,1)),
 socket_revision INTEGER NOT NULL DEFAULT 1 CHECK(socket_revision>0),
 socket_pending INTEGER NOT NULL DEFAULT 0 CHECK(socket_pending IN (0,1)),
 CHECK((run_state='running' AND claim_token IS NOT NULL AND runner_id IS NOT NULL AND lease_until IS NOT NULL) OR (run_state<>'running' AND claim_token IS NULL AND runner_id IS NULL AND lease_until IS NULL)),
 CHECK(enabled=0 OR (authorized_by IS NOT NULL AND configured_server_revision IS NOT NULL))
);
CREATE TABLE plex_owner_role (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    role_id TEXT NOT NULL UNIQUE REFERENCES user_roles(id) ON DELETE RESTRICT
);
CREATE TABLE "media_servers" (
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
CREATE TEMP TABLE baseline_role_ids (name TEXT PRIMARY KEY, id TEXT NOT NULL);
INSERT INTO baseline_role_ids VALUES ('Downloads',lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-'||substr('89ab',1+abs(random())%4,1)||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))));
INSERT INTO baseline_role_ids VALUES ('Home User',lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-'||substr('89ab',1+abs(random())%4,1)||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))));
INSERT INTO baseline_role_ids VALUES ('Shares Back',lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-'||substr('89ab',1+abs(random())%4,1)||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))));
INSERT INTO baseline_role_ids VALUES ('Owner',lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-'||substr('89ab',1+abs(random())%4,1)||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))));
INSERT INTO "admin_permissions" ("id","name","description") VALUES ('admin','administrator','Full access to the currently implemented administrator APIs.');
INSERT INTO "user_roles" ("id","name","description","position","color","icon","badge_style","is_auto_managed") VALUES ((SELECT id FROM baseline_role_ids WHERE name='Downloads'),'Downloads','Last explicitly observed provider download permission; not proof of current access.',1,'#3b82f6','fa-solid fa-download','default',1);
INSERT INTO "user_roles" ("id","name","description","position","color","icon","badge_style","is_auto_managed") VALUES ((SELECT id FROM baseline_role_ids WHERE name='Home User'),'Home User','Plex Home User with managed access',2,'#a855f7','fa-solid fa-house','default',1);
INSERT INTO "user_roles" ("id","name","description","position","color","icon","badge_style","is_auto_managed") VALUES ((SELECT id FROM baseline_role_ids WHERE name='Shares Back'),'Shares Back','User shares their library back with you',3,'#22c55e','fa-solid fa-share','default',1);
INSERT INTO "user_roles" ("id","name","description","position","color","icon","badge_style","is_auto_managed") VALUES ((SELECT id FROM baseline_role_ids WHERE name='Owner'),'Owner','Plex media server owner; does not grant MUM permissions.',4,'#f59e0b','fa-solid fa-crown','outline',1);
INSERT INTO "provider_settings" ("provider_id","enabled") VALUES ('jellyfin',0);
INSERT INTO "provider_settings" ("provider_id","enabled") VALUES ('emby',0);
INSERT INTO "provider_settings" ("provider_id","enabled") VALUES ('kavita',0);
INSERT INTO "provider_settings" ("provider_id","enabled") VALUES ('plex',0);
INSERT INTO "provider_settings" ("provider_id","enabled") VALUES ('audiobookshelf',0);
INSERT INTO "provider_settings" ("provider_id","enabled") VALUES ('komga',0);
INSERT INTO "provider_settings" ("provider_id","enabled") VALUES ('romm',0);
INSERT INTO "admin_role_state" ("singleton","revision") VALUES (1,1);
INSERT INTO "admin_notification_content" ("singleton","revision") VALUES (1,1);
INSERT INTO "account_link_state" ("singleton","revision") VALUES (1,1);
INSERT INTO "user_role_state" ("singleton","revision") VALUES (1,5);
INSERT INTO "user_role_selector_state" ("singleton","revision") VALUES (1,1);
INSERT INTO "download_role_state" ("singleton","revision") VALUES (1,2);
INSERT INTO "download_role" ("singleton","role_id") VALUES (1,(SELECT id FROM baseline_role_ids WHERE name='Downloads'));
INSERT INTO "admin_notification_signals" ("scope","revision") VALUES ('administrators',1);
INSERT INTO "discord_settings" ("singleton","revision","oauth_enabled","client_id","client_secret","redirect_uri_invite","guild_id","server_invite_url","verified_at","updated_at","sign_in_enabled","sign_in_admins","default_require_auth","default_require_guild","guild_name") VALUES (1,1,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,0,0,0,NULL);
INSERT INTO "relationship_roles" ("kind","role_id") VALUES ('home_user',(SELECT id FROM baseline_role_ids WHERE name='Home User'));
INSERT INTO "relationship_roles" ("kind","role_id") VALUES ('shares_back',(SELECT id FROM baseline_role_ids WHERE name='Shares Back'));
INSERT INTO "plex_owner_role" ("singleton","role_id") VALUES (1,(SELECT id FROM baseline_role_ids WHERE name='Owner'));
DROP TABLE baseline_role_ids;
CREATE UNIQUE INDEX one_owner ON identities(kind) WHERE kind='owner';
CREATE UNIQUE INDEX one_service_owner ON service_links(service_uuid) WHERE link_kind='owner';
CREATE INDEX service_links_reverse ON service_links(service_uuid, user_uuid);
CREATE INDEX admin_privileges_role ON admin_privileges(role_id, user_uuid);
CREATE INDEX history_user_time ON media_stream_history(user_uuid, started_at);
CREATE INDEX history_server_time ON media_stream_history(server_id, started_at);
CREATE INDEX history_server_media ON media_stream_history(server_id, external_media_item_id);
CREATE INDEX media_library_type_parent ON media_items(library_id, item_type, parent_id);
CREATE INDEX media_server_external ON media_items(server_id, external_id);
CREATE INDEX notification_time ON notifications(timestamp);
CREATE INDEX token_expiry ON token_blocklist(expires_at);
CREATE UNIQUE INDEX log_source_event ON log_entries(source, server_id, event_key) WHERE event_key IS NOT NULL AND server_id IS NOT NULL;
CREATE UNIQUE INDEX log_system_event ON log_entries(source, event_key) WHERE event_key IS NOT NULL AND server_id IS NULL;
CREATE INDEX log_server_time ON log_entries(server_id, occurred_at);
CREATE UNIQUE INDEX provisioning_request ON provisioning_jobs(invite_id,request_hash) WHERE request_hash IS NOT NULL;
CREATE INDEX provisioning_reservations ON provisioning_jobs(invite_id,reservation_held);
CREATE INDEX plex_authorization_owner ON plex_authorizations(owner_uuid,created_at);
CREATE UNIQUE INDEX plex_active_owner ON plex_connections(owner_uuid) WHERE status='active';
CREATE UNIQUE INDEX plex_active_account ON plex_connections(account_id) WHERE status='active';
CREATE INDEX plex_invitation_proof_admission ON plex_invitation_authorizations(invite_id,created_at);
CREATE INDEX plex_invitation_proof_source ON plex_invitation_authorizations(source_hash,created_at);
CREATE UNIQUE INDEX plex_invitation_active_account ON plex_invitation_credentials(account_id) WHERE status='active';
CREATE INDEX scheduled_sync_due ON server_sync_schedules(enabled,run_state,next_run_at);
CREATE INDEX activity_history_owner_time ON media_activity_history(owner_uuid,first_seen_at);
CREATE INDEX activity_history_service_time ON media_activity_history(service_uuid,first_seen_at);
CREATE INDEX activity_history_owner_cursor ON media_activity_history(owner_uuid,id DESC);
CREATE INDEX activity_history_server_cursor ON media_activity_history(server_id,id DESC);
CREATE INDEX identity_user_roles_role ON identity_user_roles(role_id,user_uuid);
CREATE UNIQUE INDEX service_account_label_source ON service_accounts(uuid,server_id,external_user_id);
CREATE UNIQUE INDEX admin_server_notice ON admin_notifications(server_id,notification_type) WHERE audience='administrators';
CREATE UNIQUE INDEX local_expiry_notice ON admin_notifications(subject_uuid,expiry_revision) WHERE notification_type='ACCOUNT_EXPIRED';
CREATE UNIQUE INDEX service_expiry_notice ON admin_notifications(subject_uuid,expiry_revision) WHERE notification_type='SERVICE_EXPIRED';
CREATE INDEX invitation_discord_proofs_invite ON invitation_discord_proofs(invite_id,status);
CREATE UNIQUE INDEX user_accounts_discord_identity ON user_accounts(discord_user_id) WHERE discord_user_id IS NOT NULL;
CREATE INDEX media_items_library_title ON media_items(library_id, sort_title COLLATE NOCASE, id);
CREATE INDEX media_items_library_year ON media_items(library_id, year, id);
CREATE INDEX activity_history_server_item ON media_activity_history(server_id, item_id, first_seen_at);
CREATE INDEX activity_history_server_parent ON media_activity_history(server_id, parent_item_id, first_seen_at);
CREATE INDEX media_items_library_parent ON media_items(library_id, parent_id, season_number, episode_number, id);
CREATE INDEX media_collections_library_title ON media_collections(library_id, sort_title COLLATE NOCASE, id);
CREATE INDEX edit_operations_actor ON edit_operations(actor_uuid,created_at);
CREATE INDEX plex_login_created ON plex_login_attempts(created_at);
CREATE INDEX service_login_attempts_created ON service_login_attempts(created_at);
CREATE UNIQUE INDEX service_links_one_owner ON service_links(service_uuid) WHERE link_kind='owner';
CREATE INDEX history_imports_account ON history_imports(server_id, account_id, viewed_at);
CREATE INDEX discord_auth_attempts_expiry ON discord_auth_attempts(expires_at);
CREATE INDEX app_sessions_user ON app_sessions(user_uuid);
CREATE INDEX session_access_expiry ON session_access_tokens(expires_at);
CREATE UNIQUE INDEX app_sessions_previous_refresh ON app_sessions(previous_refresh_hash) WHERE previous_refresh_hash IS NOT NULL;
CREATE INDEX session_refresh_history_session ON session_refresh_history(session_id);
CREATE INDEX server_refresh_due ON server_refresh_schedules(next_run_at,server_id,scope);
CREATE INDEX activity_monitor_due ON activity_monitor_schedules(enabled,run_state,next_run_at);
CREATE UNIQUE INDEX media_servers_provider_nickname ON media_servers(service_type,server_nickname);
CREATE TRIGGER protect_owner_identity_delete BEFORE DELETE ON identities WHEN OLD.kind='owner'
BEGIN SELECT RAISE(ABORT, 'owner cannot be deleted'); END;
CREATE TRIGGER protect_owner_identity_kind BEFORE UPDATE OF kind ON identities WHEN NEW.kind != OLD.kind
BEGIN SELECT RAISE(ABORT, 'identity kind is immutable'); END;
CREATE TRIGGER protect_owner_account_delete BEFORE DELETE ON user_accounts WHEN OLD.kind='owner'
BEGIN SELECT RAISE(ABORT, 'owner cannot be deleted'); END;
CREATE TRIGGER protect_owner_account_active BEFORE UPDATE OF is_active ON user_accounts
WHEN OLD.kind='owner' AND NEW.is_active=0
BEGIN SELECT RAISE(ABORT, 'owner cannot be disabled'); END;
CREATE TRIGGER admin_roles_insert_revision AFTER INSERT ON admin_roles BEGIN UPDATE admin_role_state SET revision=revision+1; END;
CREATE TRIGGER admin_roles_update_revision AFTER UPDATE ON admin_roles BEGIN UPDATE admin_role_state SET revision=revision+1; END;
CREATE TRIGGER admin_roles_delete_revision AFTER DELETE ON admin_roles BEGIN UPDATE admin_role_state SET revision=revision+1; END;
CREATE TRIGGER admin_permissions_insert_revision AFTER INSERT ON admin_permissions BEGIN UPDATE admin_role_state SET revision=revision+1; END;
CREATE TRIGGER admin_permissions_update_revision AFTER UPDATE ON admin_permissions BEGIN UPDATE admin_role_state SET revision=revision+1; END;
CREATE TRIGGER admin_permissions_delete_revision AFTER DELETE ON admin_permissions BEGIN UPDATE admin_role_state SET revision=revision+1; END;
CREATE TRIGGER admin_role_permissions_insert_revision AFTER INSERT ON admin_role_permissions BEGIN UPDATE admin_role_state SET revision=revision+1; END;
CREATE TRIGGER admin_role_permissions_update_revision AFTER UPDATE ON admin_role_permissions BEGIN UPDATE admin_role_state SET revision=revision+1; END;
CREATE TRIGGER admin_role_permissions_delete_revision AFTER DELETE ON admin_role_permissions BEGIN UPDATE admin_role_state SET revision=revision+1; END;
CREATE TRIGGER admin_privileges_insert_revision AFTER INSERT ON admin_privileges BEGIN UPDATE admin_role_state SET revision=revision+1; END;
CREATE TRIGGER admin_privileges_update_revision AFTER UPDATE ON admin_privileges BEGIN UPDATE admin_role_state SET revision=revision+1; END;
CREATE TRIGGER admin_privileges_delete_revision AFTER DELETE ON admin_privileges BEGIN UPDATE admin_role_state SET revision=revision+1; END;
CREATE TRIGGER admin_member_profile_revision AFTER UPDATE OF local_username,email,is_active,kind ON user_accounts
WHEN (OLD.local_username COLLATE BINARY IS NOT NEW.local_username COLLATE BINARY OR OLD.email IS NOT NEW.email OR OLD.is_active IS NOT NEW.is_active OR OLD.kind IS NOT NEW.kind)
AND EXISTS(SELECT 1 FROM admin_privileges WHERE user_uuid=NEW.uuid)
BEGIN UPDATE admin_role_state SET revision=revision+1; END;
CREATE TRIGGER admin_candidate_insert_revision AFTER INSERT ON user_accounts
WHEN NEW.kind='local'
BEGIN UPDATE admin_role_state SET revision=revision+1; END;
CREATE TRIGGER admin_candidate_delete_revision AFTER DELETE ON user_accounts
WHEN OLD.kind='local'
BEGIN UPDATE admin_role_state SET revision=revision+1; END;
CREATE TRIGGER admin_candidate_update_revision AFTER UPDATE OF profile_revision,local_username,email,is_active,access_expires_at,password_hash ON user_accounts
WHEN NEW.kind='local' AND (
 OLD.profile_revision IS NOT NEW.profile_revision OR
 OLD.local_username COLLATE BINARY IS NOT NEW.local_username COLLATE BINARY OR
 OLD.email IS NOT NEW.email OR OLD.is_active IS NOT NEW.is_active OR
 OLD.access_expires_at IS NOT NEW.access_expires_at OR OLD.password_hash IS NOT NEW.password_hash)
BEGIN UPDATE admin_role_state SET revision=revision+1; END;
CREATE TRIGGER activity_service_insert AFTER INSERT ON service_accounts BEGIN
 UPDATE media_activity_state SET mapping_revision=mapping_revision+1 WHERE server_id=NEW.server_id;
END;
CREATE TRIGGER activity_service_delete AFTER DELETE ON service_accounts BEGIN
 UPDATE media_activity_state SET mapping_revision=mapping_revision+1 WHERE server_id=OLD.server_id;
END;
CREATE TRIGGER activity_service_update AFTER UPDATE OF server_id,external_user_id,is_active ON service_accounts
WHEN OLD.server_id IS NOT NEW.server_id OR OLD.external_user_id IS NOT NEW.external_user_id OR OLD.is_active IS NOT NEW.is_active BEGIN
 UPDATE media_activity_state SET mapping_revision=mapping_revision+1 WHERE server_id IN (OLD.server_id,NEW.server_id);
END;
CREATE TRIGGER activity_link_insert AFTER INSERT ON service_links BEGIN
 UPDATE media_activity_state SET mapping_revision=mapping_revision+1 WHERE server_id=(SELECT server_id FROM service_accounts WHERE uuid=NEW.service_uuid);
END;
CREATE TRIGGER activity_link_delete AFTER DELETE ON service_links BEGIN
 UPDATE media_activity_state SET mapping_revision=mapping_revision+1 WHERE server_id=(SELECT server_id FROM service_accounts WHERE uuid=OLD.service_uuid);
END;
CREATE TRIGGER activity_link_update AFTER UPDATE ON service_links BEGIN
 UPDATE media_activity_state SET mapping_revision=mapping_revision+1 WHERE server_id IN (SELECT server_id FROM service_accounts WHERE uuid IN (OLD.service_uuid,NEW.service_uuid));
END;
CREATE TRIGGER account_link_insert AFTER INSERT ON service_links BEGIN
    UPDATE account_link_state SET revision=revision+1 WHERE singleton=1;
END;
CREATE TRIGGER account_link_update AFTER UPDATE ON service_links BEGIN
    UPDATE account_link_state SET revision=revision+1 WHERE singleton=1;
END;
CREATE TRIGGER account_link_delete AFTER DELETE ON service_links BEGIN
    UPDATE account_link_state SET revision=revision+1 WHERE singleton=1;
END;
CREATE TRIGGER profile_note_identity_insert AFTER INSERT ON identities BEGIN
    INSERT INTO profile_note_state(uuid) VALUES(NEW.uuid);
END;
CREATE TRIGGER profile_note_user_update AFTER UPDATE OF notes ON user_accounts
WHEN OLD.notes IS NOT NEW.notes BEGIN
    UPDATE profile_note_state SET revision=revision+1 WHERE uuid=NEW.uuid;
END;
CREATE TRIGGER profile_note_service_update AFTER UPDATE OF notes ON service_accounts
WHEN OLD.notes IS NOT NEW.notes BEGIN
    UPDATE profile_note_state SET revision=revision+1 WHERE uuid=NEW.uuid;
END;
CREATE TRIGGER human_activation_insert AFTER INSERT ON user_accounts BEGIN
    INSERT INTO human_activation_state(uuid) VALUES(NEW.uuid);
END;
CREATE TRIGGER human_activation_update AFTER UPDATE OF is_active ON user_accounts
WHEN OLD.is_active IS NOT NEW.is_active BEGIN
    UPDATE human_activation_state SET revision=revision+1 WHERE uuid=NEW.uuid;
END;
CREATE TRIGGER human_expiry_insert AFTER INSERT ON user_accounts BEGIN
    INSERT INTO human_expiry_state(uuid) VALUES(NEW.uuid);
END;
CREATE TRIGGER human_expiry_update AFTER UPDATE OF access_expires_at ON user_accounts
WHEN OLD.access_expires_at IS NOT NEW.access_expires_at BEGIN
    UPDATE human_expiry_state SET revision=revision+1 WHERE uuid=NEW.uuid;
END;
CREATE TRIGGER user_role_insert_revision AFTER INSERT ON user_roles BEGIN
    UPDATE user_role_state SET revision=revision+1;
END;
CREATE TRIGGER user_role_update_revision AFTER UPDATE ON user_roles BEGIN
    UPDATE user_role_state SET revision=revision+1;
END;
CREATE TRIGGER user_role_delete_revision AFTER DELETE ON user_roles BEGIN
    UPDATE user_role_state SET revision=revision+1;
END;
CREATE TRIGGER user_role_member_insert_revision AFTER INSERT ON identity_user_roles BEGIN
    UPDATE user_role_state SET revision=revision+1;
END;
CREATE TRIGGER user_role_member_update_revision AFTER UPDATE ON identity_user_roles BEGIN
    UPDATE user_role_state SET revision=revision+1;
END;
CREATE TRIGGER user_role_member_delete_revision AFTER DELETE ON identity_user_roles BEGIN
    UPDATE user_role_state SET revision=revision+1;
END;
CREATE TRIGGER role_selector_identity_insert AFTER INSERT ON identities BEGIN
    UPDATE user_role_selector_state SET revision=revision+1;
END;
CREATE TRIGGER role_selector_identity_delete AFTER DELETE ON identities BEGIN
    UPDATE user_role_selector_state SET revision=revision+1;
END;
CREATE TRIGGER role_selector_identity_update AFTER UPDATE OF uuid,kind ON identities
WHEN OLD.uuid IS NOT NEW.uuid OR OLD.kind IS NOT NEW.kind BEGIN
    UPDATE user_role_selector_state SET revision=revision+1;
END;
CREATE TRIGGER role_selector_human_update AFTER UPDATE OF local_username,email,is_active,access_expires_at,password_hash,profile_revision ON user_accounts
WHEN OLD.local_username IS NOT NEW.local_username OR OLD.email IS NOT NEW.email OR OLD.is_active IS NOT NEW.is_active
 OR OLD.access_expires_at IS NOT NEW.access_expires_at OR OLD.password_hash IS NOT NEW.password_hash OR OLD.profile_revision IS NOT NEW.profile_revision BEGIN
    UPDATE user_role_selector_state SET revision=revision+1;
END;
CREATE TRIGGER role_selector_service_insert AFTER INSERT ON service_accounts BEGIN
    UPDATE user_role_selector_state SET revision=revision+1;
END;
CREATE TRIGGER role_selector_service_delete AFTER DELETE ON service_accounts BEGIN
    UPDATE user_role_selector_state SET revision=revision+1;
END;
CREATE TRIGGER role_selector_service_update AFTER UPDATE OF external_username,external_email,external_user_id,external_user_alt_id,server_id,is_active ON service_accounts
WHEN OLD.external_username IS NOT NEW.external_username OR OLD.external_email IS NOT NEW.external_email
 OR OLD.external_user_id IS NOT NEW.external_user_id OR OLD.external_user_alt_id IS NOT NEW.external_user_alt_id
 OR OLD.server_id IS NOT NEW.server_id OR OLD.is_active IS NOT NEW.is_active BEGIN
    UPDATE user_role_selector_state SET revision=revision+1;
END;
CREATE TRIGGER download_role_insert AFTER INSERT ON download_role BEGIN
    UPDATE download_role_state SET revision=revision+1;
END;
CREATE TRIGGER download_role_update AFTER UPDATE ON download_role BEGIN
    UPDATE download_role_state SET revision=revision+1;
END;
CREATE TRIGGER download_role_delete AFTER DELETE ON download_role BEGIN
    UPDATE download_role_state SET revision=revision+1;
END;
CREATE TRIGGER download_definition_update AFTER UPDATE ON user_roles
WHEN EXISTS(SELECT 1 FROM download_role WHERE role_id=OLD.id OR role_id=NEW.id) BEGIN
    UPDATE download_role_state SET revision=revision+1;
END;
CREATE TRIGGER human_credential_insert AFTER INSERT ON user_accounts BEGIN
    INSERT INTO human_credential_state(uuid) VALUES(NEW.uuid);
END;
CREATE TRIGGER human_credential_update AFTER UPDATE OF password_hash,local_username,force_password_change ON user_accounts
WHEN NEW.password_hash IS NOT OLD.password_hash OR NEW.local_username IS NOT OLD.local_username OR NEW.force_password_change IS NOT OLD.force_password_change BEGIN
    UPDATE human_credential_state SET revision=revision+1 WHERE uuid=NEW.uuid;
END;
CREATE TRIGGER admin_notice_insert AFTER INSERT ON admin_notifications BEGIN UPDATE admin_notification_content SET revision=revision+1; END;
CREATE TRIGGER admin_notice_update AFTER UPDATE ON admin_notifications BEGIN UPDATE admin_notification_content SET revision=revision+1; END;
CREATE TRIGGER admin_notice_delete AFTER DELETE ON admin_notifications BEGIN UPDATE admin_notification_content SET revision=revision+1; END;
CREATE TRIGGER admin_receipt_insert AFTER INSERT ON admin_notification_receipts BEGIN
 INSERT INTO admin_notification_inboxes VALUES(NEW.user_uuid,2) ON CONFLICT(user_uuid) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER admin_receipt_update AFTER UPDATE ON admin_notification_receipts BEGIN
 INSERT INTO admin_notification_inboxes VALUES(NEW.user_uuid,2) ON CONFLICT(user_uuid) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER admin_receipt_delete AFTER DELETE ON admin_notification_receipts BEGIN
 UPDATE admin_notification_inboxes SET revision=revision+1 WHERE user_uuid=OLD.user_uuid;
END;
CREATE TRIGGER admin_notice_signal_insert AFTER INSERT ON admin_notifications BEGIN
 INSERT INTO admin_notification_signals VALUES(CASE WHEN NEW.audience='administrators' THEN 'administrators' ELSE NEW.recipient_uuid END,1)
 ON CONFLICT(scope) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER admin_notice_signal_delete AFTER DELETE ON admin_notifications BEGIN
 INSERT INTO admin_notification_signals VALUES(CASE WHEN OLD.audience='administrators' THEN 'administrators' ELSE OLD.recipient_uuid END,1)
 ON CONFLICT(scope) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER admin_notice_signal_update AFTER UPDATE ON admin_notifications BEGIN
 INSERT INTO admin_notification_signals VALUES(CASE WHEN OLD.audience='administrators' THEN 'administrators' ELSE OLD.recipient_uuid END,1)
 ON CONFLICT(scope) DO UPDATE SET revision=revision+1;
 INSERT INTO admin_notification_signals VALUES(CASE WHEN NEW.audience='administrators' THEN 'administrators' ELSE NEW.recipient_uuid END,1)
 ON CONFLICT(scope) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER service_expiry_insert AFTER INSERT ON service_accounts BEGIN INSERT INTO service_expiry_state(uuid) VALUES(NEW.uuid); END;
CREATE TRIGGER service_expiry_update AFTER UPDATE OF access_expires_at ON service_accounts WHEN OLD.access_expires_at IS NOT NEW.access_expires_at BEGIN
 UPDATE service_expiry_state SET revision=revision+1 WHERE uuid=NEW.uuid;
 UPDATE media_activity_state SET mapping_revision=mapping_revision+1 WHERE server_id=NEW.server_id;
 UPDATE account_link_state SET revision=revision+1 WHERE singleton=1;
END;
CREATE TRIGGER service_remote_access_insert AFTER INSERT ON service_accounts BEGIN
 INSERT INTO service_remote_access(service_uuid) VALUES(NEW.uuid);
END;
CREATE TRIGGER create_activity_monitor AFTER INSERT ON media_activity_state BEGIN
 INSERT INTO activity_monitor_schedules(server_id) VALUES(NEW.server_id);
END;
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
CREATE TRIGGER provider_config_revision AFTER UPDATE OF enabled ON provider_settings
 WHEN OLD.enabled IS NOT NEW.enabled
BEGIN
 UPDATE media_servers SET config_revision=config_revision+1 WHERE service_type=NEW.provider_id;
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
