CREATE TRIGGER admin_candidate_insert_revision AFTER INSERT ON user_accounts
WHEN NEW.kind='local'
BEGIN UPDATE admin_role_state SET revision=revision+1; END;
CREATE TRIGGER admin_candidate_delete_revision AFTER DELETE ON user_accounts
WHEN OLD.kind='local'
BEGIN UPDATE admin_role_state SET revision=revision+1; END;
CREATE TRIGGER admin_candidate_update_revision AFTER UPDATE OF profile_revision,local_username,email,is_active,access_expires_at,password_hash ON user_accounts
WHEN NEW.kind='local' AND (
 OLD.profile_revision IS NOT NEW.profile_revision OR
 OLD.local_username COLLATE BINARY IS NOT NEW.local_username COLLATE BINARY OR
 OLD.email IS NOT NEW.email OR OLD.is_active IS NOT NEW.is_active OR
 OLD.access_expires_at IS NOT NEW.access_expires_at OR OLD.password_hash IS NOT NEW.password_hash)
BEGIN UPDATE admin_role_state SET revision=revision+1; END;
