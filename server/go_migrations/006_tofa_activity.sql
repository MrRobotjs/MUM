-- Tofa is an activity source. Preserve existing state and initialize new and existing servers.
DROP TRIGGER create_activity_state;
CREATE TRIGGER create_activity_state AFTER INSERT ON media_servers
WHEN NEW.service_type IN ('jellyfin','emby','plex','tofa') BEGIN
 INSERT INTO media_activity_state(server_id) VALUES(NEW.id);
END;
INSERT INTO media_activity_state(server_id)
 SELECT id FROM media_servers WHERE service_type='tofa'
 ON CONFLICT(server_id) DO NOTHING;
