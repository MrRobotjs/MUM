-- The player's platform as Plex reports it ("Android", "Roku", "tvOS",
-- "Chrome"), so the Profile tab's Players card can show a logo for each app
-- like Tautulli (user decision 2026-11-17). Other services report none; NULL
-- also means unknown for every play recorded before this migration.
ALTER TABLE media_activity_history ADD COLUMN platform TEXT CHECK(platform IS NULL OR length(platform) BETWEEN 1 AND 64);
