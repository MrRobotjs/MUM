-- Posters for plays imported from a Plex server's own history. The same
-- reference MUM keeps with its own plays: the item whose
-- poster it is (the movie, the show of an episode, the album of a track) and
-- that item's own thumbnail path. Every import run fills in a missing poster
-- and never replaces one already stored.
ALTER TABLE plex_history_imports ADD COLUMN poster_item TEXT CHECK(poster_item IS NULL OR length(poster_item) BETWEEN 1 AND 256);
ALTER TABLE plex_history_imports ADD COLUMN poster_path TEXT CHECK(poster_path IS NULL OR (poster_item IS NOT NULL AND length(poster_path) BETWEEN 1 AND 1024));
