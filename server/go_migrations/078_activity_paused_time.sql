-- Paused time per recorded play (user decision 2026-11-17), so the Profile
-- tab can show watched time like Tautulli: seen time less paused time. MUM
-- adds the time from each paused reading to the next one. Plays recorded
-- before this have NULL: their paused time is unknown.
ALTER TABLE media_activity_history ADD COLUMN paused_seconds INTEGER CHECK(paused_seconds IS NULL OR paused_seconds>=0);
