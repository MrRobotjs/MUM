-- Play history imported from every supported service. One store replaces the
-- Plex-only tables of 074 and
-- 075; their rows and run status move here unchanged.
--
-- One row per entry of a server's own history; repeat imports skip stored keys.
-- The account ID is matched to a server account when read, so accounts synced
-- later still match. Jellyfin and Emby IDs are stored as the server account has
-- them when it is known, otherwise in canonical form. Only Audiobookshelf
-- reports how far and how long (in seconds).
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
 imported_at TEXT NOT NULL,
 PRIMARY KEY(server_id, entry_key)
);
CREATE INDEX history_imports_account ON history_imports(server_id, account_id, viewed_at);

INSERT INTO history_imports(server_id,entry_key,account_id,viewed_at,media_type,item_id,library_id,title,parent_title,grandparent_title,poster_item,poster_path,imported_at)
 SELECT server_id,history_key,account_id,viewed_at,media_type,rating_key,library_section_id,title,parent_title,grandparent_title,poster_item,poster_path,imported_at FROM plex_history_imports;

-- The latest import run per server, for its status and counts. A run that was
-- going when MUM stopped is marked stopped at the next start.
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
);

INSERT INTO history_import_runs(server_id,state,started_at,finished_at,total,read_count,added,already_stored,already_recorded,unknown_accounts,error_code)
 SELECT server_id,state,started_at,finished_at,total,read_count,added,already_stored,already_recorded,unknown_accounts,
  CASE error_code WHEN 'plex_read_failed' THEN 'server_read_failed' WHEN 'plex_page_mismatch' THEN 'page_mismatch' ELSE error_code END
 FROM plex_history_import_runs;

DROP TABLE plex_history_imports;
DROP TABLE plex_history_import_runs;
