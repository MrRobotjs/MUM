-- Purge and purge protection.
--
-- Plays read from a Plex server's own history, kept apart from MUM's activity
-- history because they have no length, player or quality. Only the purge reads
-- them. One row per Plex history entry; repeat imports skip stored keys. The
-- Plex account ID is matched to a server account when read, so accounts synced
-- later still match.
CREATE TABLE plex_history_imports (
 server_id INTEGER NOT NULL REFERENCES media_servers(id) ON DELETE CASCADE,
 history_key TEXT NOT NULL CHECK(length(history_key) BETWEEN 1 AND 256),
 account_id TEXT NOT NULL CHECK(length(account_id) BETWEEN 1 AND 64),
 viewed_at TEXT NOT NULL,
 media_type TEXT CHECK(media_type IS NULL OR length(media_type) BETWEEN 1 AND 32),
 rating_key TEXT CHECK(rating_key IS NULL OR length(rating_key) BETWEEN 1 AND 256),
 library_section_id TEXT CHECK(library_section_id IS NULL OR length(library_section_id) BETWEEN 1 AND 64),
 title TEXT CHECK(title IS NULL OR length(title) BETWEEN 1 AND 1024),
 parent_title TEXT CHECK(parent_title IS NULL OR length(parent_title) BETWEEN 1 AND 1024),
 grandparent_title TEXT CHECK(grandparent_title IS NULL OR length(grandparent_title) BETWEEN 1 AND 1024),
 imported_at TEXT NOT NULL,
 PRIMARY KEY(server_id, history_key)
);
CREATE INDEX plex_history_imports_account ON plex_history_imports(server_id, account_id, viewed_at);

-- The latest import run per Plex server, for its status and counts. A run
-- that was going when MUM stopped is marked stopped at the next start.
CREATE TABLE plex_history_import_runs (
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
);

-- Invitations can protect the accounts they create from purges, per server.
ALTER TABLE invitation_grants ADD COLUMN purge_protected INTEGER NOT NULL DEFAULT 0 CHECK(purge_protected IN (0,1));
