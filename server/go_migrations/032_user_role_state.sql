CREATE TABLE user_role_state (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0 AND typeof(revision)='integer')
);
INSERT INTO user_role_state(singleton) VALUES(1);
CREATE TRIGGER user_role_insert_revision AFTER INSERT ON user_roles BEGIN
    UPDATE user_role_state SET revision=revision+1;
END;
CREATE TRIGGER user_role_update_revision AFTER UPDATE ON user_roles BEGIN
    UPDATE user_role_state SET revision=revision+1;
END;
CREATE TRIGGER user_role_delete_revision AFTER DELETE ON user_roles BEGIN
    UPDATE user_role_state SET revision=revision+1;
END;
CREATE TRIGGER user_role_member_insert_revision AFTER INSERT ON identity_user_roles BEGIN
    UPDATE user_role_state SET revision=revision+1;
END;
CREATE TRIGGER user_role_member_update_revision AFTER UPDATE ON identity_user_roles BEGIN
    UPDATE user_role_state SET revision=revision+1;
END;
CREATE TRIGGER user_role_member_delete_revision AFTER DELETE ON identity_user_roles BEGIN
    UPDATE user_role_state SET revision=revision+1;
END;
