-- Per-library item catalogue state. catalogue_revision fences stale provider
-- snapshots: a sync commits only against the revision it read before fetching,
-- and every committed sync or purge advances it.
ALTER TABLE media_libraries ADD COLUMN catalogue_revision INTEGER NOT NULL DEFAULT 1 CHECK(catalogue_revision>0 AND typeof(catalogue_revision)='integer');
ALTER TABLE media_libraries ADD COLUMN catalogue_synced_at TEXT;
ALTER TABLE media_libraries ADD COLUMN catalogue_item_count INTEGER CHECK(catalogue_item_count IS NULL OR (catalogue_item_count>=0 AND typeof(catalogue_item_count)='integer'));
CREATE INDEX media_items_library_title ON media_items(library_id, sort_title COLLATE NOCASE, id);
CREATE INDEX media_items_library_year ON media_items(library_id, year, id);
