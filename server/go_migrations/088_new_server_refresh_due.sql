-- New servers receive initial due times; startup preferences are applied
-- separately when the scheduler starts.
DROP TRIGGER create_server_refresh;
CREATE TRIGGER create_server_refresh AFTER INSERT ON media_servers BEGIN
 INSERT INTO server_refresh_settings(server_id) VALUES(NEW.id);
 INSERT INTO server_refresh_schedules(server_id,scope,next_run_at) VALUES(NEW.id,'users',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
 INSERT INTO server_refresh_schedules(server_id,scope,next_run_at) VALUES(NEW.id,'libraries',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
