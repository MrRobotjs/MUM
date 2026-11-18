-- The player's IP address as the server reported it, kept with each recorded
-- play for the History tab's IP column like Tautulli (user decision
-- 2026-11-17). Only administrators see it. Plex reports it; NULL means
-- unknown, including every play recorded before this migration.
ALTER TABLE media_activity_history ADD COLUMN ip_address TEXT CHECK(ip_address IS NULL OR length(ip_address) BETWEEN 2 AND 45);
