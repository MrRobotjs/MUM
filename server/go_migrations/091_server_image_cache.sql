ALTER TABLE media_servers ADD COLUMN cache_images INTEGER NOT NULL DEFAULT 1 CHECK(cache_images IN (0,1));
