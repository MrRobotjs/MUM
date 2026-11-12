CREATE TABLE romm_download_role_state (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0 AND typeof(revision)='integer')
);
INSERT INTO romm_download_role_state(singleton) VALUES(1);
CREATE TABLE romm_download_role (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    role_id TEXT NOT NULL UNIQUE REFERENCES user_roles(id) ON DELETE RESTRICT
);
CREATE TRIGGER romm_download_role_insert AFTER INSERT ON romm_download_role BEGIN
    UPDATE romm_download_role_state SET revision=revision+1;
END;
CREATE TRIGGER romm_download_role_update AFTER UPDATE ON romm_download_role BEGIN
    UPDATE romm_download_role_state SET revision=revision+1;
END;
CREATE TRIGGER romm_download_role_delete AFTER DELETE ON romm_download_role BEGIN
    UPDATE romm_download_role_state SET revision=revision+1;
END;
CREATE TRIGGER romm_download_definition_update AFTER UPDATE ON user_roles
WHEN EXISTS(SELECT 1 FROM romm_download_role WHERE role_id=OLD.id OR role_id=NEW.id) BEGIN
    UPDATE romm_download_role_state SET revision=revision+1;
END;
CREATE UNIQUE INDEX service_account_label_source ON service_accounts(uuid,server_id,external_user_id);
CREATE TABLE romm_download_observations (
    service_uuid TEXT PRIMARY KEY,
    server_id INTEGER NOT NULL,
    external_user_id TEXT NOT NULL,
    role_id TEXT NOT NULL REFERENCES romm_download_role(role_id) ON DELETE RESTRICT,
    allowed INTEGER NOT NULL CHECK(allowed IN (0,1)),
    source_revision INTEGER NOT NULL CHECK(source_revision>0 AND typeof(source_revision)='integer'),
    observed_at TEXT NOT NULL,
    FOREIGN KEY(service_uuid,server_id,external_user_id)
        REFERENCES service_accounts(uuid,server_id,external_user_id) ON DELETE CASCADE
);
