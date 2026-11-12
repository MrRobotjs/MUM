CREATE TABLE media_activity_state(
 server_id INTEGER PRIMARY KEY REFERENCES media_servers(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
 generation INTEGER NOT NULL DEFAULT 0 CHECK(generation>=0),
 mapping_revision INTEGER NOT NULL DEFAULT 1 CHECK(mapping_revision>0),
 pending_token TEXT,
 pending_at TEXT,
 pending_until TEXT,
 observed_at TEXT,
 observed_server_revision INTEGER,
 observed_mapping_revision INTEGER,
 last_result TEXT NOT NULL DEFAULT 'never' CHECK(last_result IN ('never','fresh','failed'))
);
INSERT INTO media_activity_state(server_id) SELECT id FROM media_servers WHERE service_type IN ('jellyfin','emby');
CREATE TRIGGER create_activity_state AFTER INSERT ON media_servers WHEN NEW.service_type IN ('jellyfin','emby') BEGIN
 INSERT INTO media_activity_state(server_id) VALUES(NEW.id);
END;
CREATE TABLE media_activity_history(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 server_id INTEGER NOT NULL REFERENCES media_servers(id),
 external_session_id TEXT NOT NULL,
 service_uuid TEXT NOT NULL REFERENCES service_accounts(uuid),
 owner_uuid TEXT REFERENCES user_accounts(uuid),
 item_id TEXT NOT NULL,
 media_type TEXT NOT NULL,
 title TEXT NOT NULL,
 first_seen_at TEXT NOT NULL,
 last_seen_at TEXT NOT NULL,
 ended_at TEXT,
 end_reason TEXT CHECK(end_reason IN ('not_observed','item_changed','identity_changed','ownership_changed')),
 paused INTEGER NOT NULL CHECK(paused IN (0,1)),
 position_ticks INTEGER CHECK(position_ticks>=0),
 duration_ticks INTEGER CHECK(duration_ticks>=0),
 CHECK((ended_at IS NULL AND end_reason IS NULL) OR (ended_at IS NOT NULL AND end_reason IS NOT NULL)),
 UNIQUE(id,server_id,external_session_id)
);
CREATE INDEX activity_history_owner_time ON media_activity_history(owner_uuid,first_seen_at);
CREATE INDEX activity_history_service_time ON media_activity_history(service_uuid,first_seen_at);
CREATE TABLE media_activity_current(
 server_id INTEGER NOT NULL REFERENCES media_servers(id),
 external_session_id TEXT NOT NULL,
 history_id INTEGER NOT NULL UNIQUE REFERENCES media_activity_history(id),
 PRIMARY KEY(server_id,external_session_id),
 FOREIGN KEY(history_id,server_id,external_session_id) REFERENCES media_activity_history(id,server_id,external_session_id)
);

CREATE TRIGGER activity_service_insert AFTER INSERT ON service_accounts BEGIN
 UPDATE media_activity_state SET mapping_revision=mapping_revision+1 WHERE server_id=NEW.server_id;
END;
CREATE TRIGGER activity_service_delete AFTER DELETE ON service_accounts BEGIN
 UPDATE media_activity_state SET mapping_revision=mapping_revision+1 WHERE server_id=OLD.server_id;
END;
CREATE TRIGGER activity_service_update AFTER UPDATE OF server_id,external_user_id,is_active ON service_accounts
WHEN OLD.server_id IS NOT NEW.server_id OR OLD.external_user_id IS NOT NEW.external_user_id OR OLD.is_active IS NOT NEW.is_active BEGIN
 UPDATE media_activity_state SET mapping_revision=mapping_revision+1 WHERE server_id IN (OLD.server_id,NEW.server_id);
END;
CREATE TRIGGER activity_link_insert AFTER INSERT ON service_links BEGIN
 UPDATE media_activity_state SET mapping_revision=mapping_revision+1 WHERE server_id=(SELECT server_id FROM service_accounts WHERE uuid=NEW.service_uuid);
END;
CREATE TRIGGER activity_link_delete AFTER DELETE ON service_links BEGIN
 UPDATE media_activity_state SET mapping_revision=mapping_revision+1 WHERE server_id=(SELECT server_id FROM service_accounts WHERE uuid=OLD.service_uuid);
END;
CREATE TRIGGER activity_link_update AFTER UPDATE ON service_links BEGIN
 UPDATE media_activity_state SET mapping_revision=mapping_revision+1 WHERE server_id IN (SELECT server_id FROM service_accounts WHERE uuid IN (OLD.service_uuid,NEW.service_uuid));
END;
