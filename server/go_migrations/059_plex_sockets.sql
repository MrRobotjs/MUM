ALTER TABLE activity_monitor_schedules ADD COLUMN socket_pending INTEGER NOT NULL DEFAULT 0 CHECK(socket_pending IN (0,1));
ALTER TABLE media_activity_state ADD COLUMN observed_source TEXT NOT NULL DEFAULT 'http' CHECK(observed_source IN ('http','ws'));
-- Plex socket controls were previously unavailable. Prefer native hints for
-- already-enabled Plex monitors; retain disabled monitors and other choices.
UPDATE activity_monitor_schedules SET socket_enabled=1,socket_revision=socket_revision+1,revision=revision+1
WHERE enabled=1 AND server_id IN (SELECT id FROM media_servers WHERE service_type='plex');
