-- The series of an episode or the album of a track, so retained plays can be
-- attributed to library catalogue items. NULL for movies and older rows.
ALTER TABLE media_activity_history ADD COLUMN parent_item_id TEXT CHECK(parent_item_id IS NULL OR length(parent_item_id) BETWEEN 1 AND 256);
ALTER TABLE media_activity_history ADD COLUMN parent_title TEXT CHECK(parent_title IS NULL OR (parent_item_id IS NOT NULL AND length(parent_title) BETWEEN 1 AND 1024));
CREATE INDEX activity_history_server_item ON media_activity_history(server_id, item_id, first_seen_at);
CREATE INDEX activity_history_server_parent ON media_activity_history(server_id, parent_item_id, first_seen_at);
