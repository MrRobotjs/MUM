-- Transactional revision fences expose no history payload to socket clients.
CREATE TABLE history_realtime_global (singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL);
INSERT INTO history_realtime_global VALUES(1,1);
CREATE TABLE history_realtime_service (service_uuid TEXT NOT NULL, owner_uuid TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(service_uuid,owner_uuid));
CREATE TABLE history_realtime_import (server_id INTEGER NOT NULL, account_id TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(server_id,account_id));
CREATE TRIGGER history_realtime_recorded_insert AFTER INSERT ON media_activity_history BEGIN
 UPDATE history_realtime_global SET revision=revision+1 WHERE singleton=1;
 INSERT INTO history_realtime_service SELECT NEW.service_uuid,NEW.owner_uuid,1 WHERE NEW.owner_uuid IS NOT NULL ON CONFLICT(service_uuid,owner_uuid) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER history_realtime_imported_insert AFTER INSERT ON history_imports BEGIN
 UPDATE history_realtime_global SET revision=revision+1 WHERE singleton=1;
 INSERT INTO history_realtime_import VALUES(NEW.server_id,NEW.account_id,1) ON CONFLICT(server_id,account_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER history_realtime_recorded_update AFTER UPDATE ON media_activity_history BEGIN
 UPDATE history_realtime_global SET revision=revision+1 WHERE singleton=1;
 INSERT INTO history_realtime_service SELECT OLD.service_uuid,OLD.owner_uuid,1 WHERE OLD.owner_uuid IS NOT NULL ON CONFLICT(service_uuid,owner_uuid) DO UPDATE SET revision=revision+1;
 INSERT INTO history_realtime_service SELECT NEW.service_uuid,NEW.owner_uuid,1 WHERE NEW.owner_uuid IS NOT NULL ON CONFLICT(service_uuid,owner_uuid) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER history_realtime_imported_update AFTER UPDATE ON history_imports BEGIN
 UPDATE history_realtime_global SET revision=revision+1 WHERE singleton=1;
 INSERT INTO history_realtime_import VALUES(OLD.server_id,OLD.account_id,1) ON CONFLICT(server_id,account_id) DO UPDATE SET revision=revision+1;
 INSERT INTO history_realtime_import VALUES(NEW.server_id,NEW.account_id,1) ON CONFLICT(server_id,account_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER history_realtime_recorded_delete AFTER DELETE ON media_activity_history BEGIN
 UPDATE history_realtime_global SET revision=revision+1 WHERE singleton=1;
 INSERT INTO history_realtime_service SELECT OLD.service_uuid,OLD.owner_uuid,1 WHERE OLD.owner_uuid IS NOT NULL ON CONFLICT(service_uuid,owner_uuid) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER history_realtime_imported_delete AFTER DELETE ON history_imports BEGIN
 UPDATE history_realtime_global SET revision=revision+1 WHERE singleton=1;
 INSERT INTO history_realtime_import VALUES(OLD.server_id,OLD.account_id,1) ON CONFLICT(server_id,account_id) DO UPDATE SET revision=revision+1;
END;
