CREATE TABLE user_role_selector_state (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0 AND typeof(revision)='integer')
);
INSERT INTO user_role_selector_state(singleton) VALUES(1);
CREATE TRIGGER role_selector_identity_insert AFTER INSERT ON identities BEGIN
    UPDATE user_role_selector_state SET revision=revision+1;
END;
CREATE TRIGGER role_selector_identity_delete AFTER DELETE ON identities BEGIN
    UPDATE user_role_selector_state SET revision=revision+1;
END;
CREATE TRIGGER role_selector_identity_update AFTER UPDATE OF uuid,kind ON identities
WHEN OLD.uuid IS NOT NEW.uuid OR OLD.kind IS NOT NEW.kind BEGIN
    UPDATE user_role_selector_state SET revision=revision+1;
END;
CREATE TRIGGER role_selector_human_update AFTER UPDATE OF local_username,email,is_active,access_expires_at,password_hash,profile_revision ON user_accounts
WHEN OLD.local_username IS NOT NEW.local_username OR OLD.email IS NOT NEW.email OR OLD.is_active IS NOT NEW.is_active
 OR OLD.access_expires_at IS NOT NEW.access_expires_at OR OLD.password_hash IS NOT NEW.password_hash OR OLD.profile_revision IS NOT NEW.profile_revision BEGIN
    UPDATE user_role_selector_state SET revision=revision+1;
END;
CREATE TRIGGER role_selector_service_insert AFTER INSERT ON service_accounts BEGIN
    UPDATE user_role_selector_state SET revision=revision+1;
END;
CREATE TRIGGER role_selector_service_delete AFTER DELETE ON service_accounts BEGIN
    UPDATE user_role_selector_state SET revision=revision+1;
END;
CREATE TRIGGER role_selector_service_update AFTER UPDATE OF external_username,external_email,external_user_id,external_user_alt_id,server_id,is_active ON service_accounts
WHEN OLD.external_username IS NOT NEW.external_username OR OLD.external_email IS NOT NEW.external_email
 OR OLD.external_user_id IS NOT NEW.external_user_id OR OLD.external_user_alt_id IS NOT NEW.external_user_alt_id
 OR OLD.server_id IS NOT NEW.server_id OR OLD.is_active IS NOT NEW.is_active BEGIN
    UPDATE user_role_selector_state SET revision=revision+1;
END;
CREATE TRIGGER role_selector_server_update AFTER UPDATE OF server_nickname,service_type ON media_servers
WHEN OLD.server_nickname IS NOT NEW.server_nickname OR OLD.service_type IS NOT NEW.service_type BEGIN
    UPDATE user_role_selector_state SET revision=revision+1;
END;
