CREATE TABLE provider_settings (
    provider_id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1))
);
INSERT INTO provider_settings(provider_id) VALUES ('jellyfin'),('emby'),('kavita');
ALTER TABLE media_servers ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE media_libraries ADD COLUMN is_available INTEGER NOT NULL DEFAULT 1 CHECK (is_available IN (0,1));
