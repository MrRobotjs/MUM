-- Add Plex polling without changing existing consent or enabling sockets.
DROP TRIGGER create_activity_state;
CREATE TRIGGER create_activity_state AFTER INSERT ON media_servers
WHEN NEW.service_type IN ('jellyfin','emby','plex') BEGIN
 INSERT INTO media_activity_state(server_id) VALUES(NEW.id);
END;
INSERT INTO media_activity_state(server_id)
SELECT id FROM media_servers WHERE service_type='plex'
AND NOT EXISTS(SELECT 1 FROM media_activity_state a WHERE a.server_id=media_servers.id);
