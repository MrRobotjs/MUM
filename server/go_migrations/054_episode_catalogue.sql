-- Per-series episode catalogue state. episode_revision fences stale episode
-- snapshots for one series the same way catalogue_revision does for a library.
ALTER TABLE media_items ADD COLUMN episode_revision INTEGER NOT NULL DEFAULT 1 CHECK(episode_revision>0 AND typeof(episode_revision)='integer');
ALTER TABLE media_items ADD COLUMN episodes_synced_at TEXT;
ALTER TABLE media_items ADD COLUMN episode_count INTEGER CHECK(episode_count IS NULL OR (episode_count>=0 AND typeof(episode_count)='integer'));
CREATE INDEX media_items_library_parent ON media_items(library_id, parent_id, season_number, episode_number, id);
