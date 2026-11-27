-- A library item's IDs in the shared movie and TV databases (TMDB, TVDB and
-- IMDb), as its media server reports them. They are the same on every server,
-- so the same title can be matched across servers and with outside services.
ALTER TABLE media_items ADD COLUMN tmdb_id INTEGER CHECK(tmdb_id IS NULL OR (typeof(tmdb_id)='integer' AND tmdb_id BETWEEN 1 AND 2147483648));
ALTER TABLE media_items ADD COLUMN tvdb_id INTEGER CHECK(tvdb_id IS NULL OR (typeof(tvdb_id)='integer' AND tvdb_id BETWEEN 1 AND 2147483648));
ALTER TABLE media_items ADD COLUMN imdb_id TEXT CHECK(imdb_id IS NULL OR (imdb_id GLOB 'tt[0-9][0-9][0-9][0-9][0-9][0-9]*' AND length(imdb_id) BETWEEN 8 AND 12 AND substr(imdb_id,3) NOT GLOB '*[^0-9]*'));
CREATE INDEX media_items_tmdb_id ON media_items(tmdb_id) WHERE tmdb_id IS NOT NULL;
CREATE INDEX media_items_tvdb_id ON media_items(tvdb_id) WHERE tvdb_id IS NOT NULL;
CREATE INDEX media_items_imdb_id ON media_items(imdb_id) WHERE imdb_id IS NOT NULL;
