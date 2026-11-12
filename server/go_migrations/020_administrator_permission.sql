INSERT INTO admin_permissions(id,name,description)
VALUES('admin','administrator','Full access to the currently implemented administrator APIs.');

CREATE TABLE admin_role_state (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    revision INTEGER NOT NULL CHECK(revision>0)
);
INSERT INTO admin_role_state VALUES(1,1);
CREATE TRIGGER admin_roles_insert_revision AFTER INSERT ON admin_roles BEGIN UPDATE admin_role_state SET revision=revision+1; END;
CREATE TRIGGER admin_roles_update_revision AFTER UPDATE ON admin_roles BEGIN UPDATE admin_role_state SET revision=revision+1; END;
CREATE TRIGGER admin_roles_delete_revision AFTER DELETE ON admin_roles BEGIN UPDATE admin_role_state SET revision=revision+1; END;
CREATE TRIGGER admin_permissions_insert_revision AFTER INSERT ON admin_permissions BEGIN UPDATE admin_role_state SET revision=revision+1; END;
CREATE TRIGGER admin_permissions_update_revision AFTER UPDATE ON admin_permissions BEGIN UPDATE admin_role_state SET revision=revision+1; END;
CREATE TRIGGER admin_permissions_delete_revision AFTER DELETE ON admin_permissions BEGIN UPDATE admin_role_state SET revision=revision+1; END;
CREATE TRIGGER admin_role_permissions_insert_revision AFTER INSERT ON admin_role_permissions BEGIN UPDATE admin_role_state SET revision=revision+1; END;
CREATE TRIGGER admin_role_permissions_update_revision AFTER UPDATE ON admin_role_permissions BEGIN UPDATE admin_role_state SET revision=revision+1; END;
CREATE TRIGGER admin_role_permissions_delete_revision AFTER DELETE ON admin_role_permissions BEGIN UPDATE admin_role_state SET revision=revision+1; END;
CREATE TRIGGER admin_privileges_insert_revision AFTER INSERT ON admin_privileges BEGIN UPDATE admin_role_state SET revision=revision+1; END;
CREATE TRIGGER admin_privileges_update_revision AFTER UPDATE ON admin_privileges BEGIN UPDATE admin_role_state SET revision=revision+1; END;
CREATE TRIGGER admin_privileges_delete_revision AFTER DELETE ON admin_privileges BEGIN UPDATE admin_role_state SET revision=revision+1; END;
CREATE TRIGGER admin_member_profile_revision AFTER UPDATE OF local_username,email,is_active,kind ON user_accounts
WHEN (OLD.local_username COLLATE BINARY IS NOT NEW.local_username COLLATE BINARY OR OLD.email IS NOT NEW.email OR OLD.is_active IS NOT NEW.is_active OR OLD.kind IS NOT NEW.kind)
AND EXISTS(SELECT 1 FROM admin_privileges WHERE user_uuid=NEW.uuid)
BEGIN UPDATE admin_role_state SET revision=revision+1; END;
