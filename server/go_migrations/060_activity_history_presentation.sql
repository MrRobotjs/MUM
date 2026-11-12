-- Presentation kept with each retained play, so history can show its poster and
-- library after the live session (and its display) is gone. The poster is a
-- validated Plex catalogue reference served only through the signed history
-- image proxy; NULL when the provider sent none or for older rows.
ALTER TABLE media_activity_history ADD COLUMN poster_item TEXT CHECK(poster_item IS NULL OR length(poster_item) BETWEEN 1 AND 256);
ALTER TABLE media_activity_history ADD COLUMN poster_path TEXT CHECK(poster_path IS NULL OR (poster_item IS NOT NULL AND length(poster_path) BETWEEN 1 AND 1024));
ALTER TABLE media_activity_history ADD COLUMN library_name TEXT CHECK(library_name IS NULL OR length(library_name) BETWEEN 1 AND 1024);
