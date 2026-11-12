CREATE TABLE identities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('owner','local','service')),
    UNIQUE (uuid, kind)
);
CREATE UNIQUE INDEX one_owner ON identities(kind) WHERE kind='owner';

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
    legacy_metadata TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(legacy_metadata)),
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
    legacy_metadata TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(legacy_metadata)),
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
CREATE UNIQUE INDEX one_service_owner ON service_links(service_uuid) WHERE link_kind='owner';
CREATE INDEX service_links_reverse ON service_links(service_uuid, user_uuid);

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
CREATE INDEX admin_privileges_role ON admin_privileges(role_id, user_uuid);

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

CREATE TRIGGER protect_owner_identity_delete BEFORE DELETE ON identities WHEN OLD.kind='owner'
BEGIN SELECT RAISE(ABORT, 'owner cannot be deleted'); END;
CREATE TRIGGER protect_owner_identity_kind BEFORE UPDATE OF kind ON identities WHEN NEW.kind != OLD.kind
BEGIN SELECT RAISE(ABORT, 'identity kind is immutable'); END;
CREATE TRIGGER protect_owner_account_delete BEFORE DELETE ON user_accounts WHEN OLD.kind='owner'
BEGIN SELECT RAISE(ABORT, 'owner cannot be deleted'); END;
CREATE TRIGGER protect_owner_account_active BEFORE UPDATE OF is_active ON user_accounts
WHEN OLD.kind='owner' AND NEW.is_active=0
BEGIN SELECT RAISE(ABORT, 'owner cannot be disabled'); END;
