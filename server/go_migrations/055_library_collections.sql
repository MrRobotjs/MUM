-- Per-library collection snapshot (Plex). Collections are not playable items,
-- so they are kept apart from media_items. A snapshot is committed together
-- with the library's item snapshot and fenced by the same catalogue_revision.
-- Membership is not stored: no current consumer reads it.
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
CREATE INDEX media_collections_library_title ON media_collections(library_id, sort_title COLLATE NOCASE, id);
