CREATE TABLE human_activation_state (
    uuid TEXT PRIMARY KEY REFERENCES user_accounts(uuid) ON DELETE CASCADE,
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0 AND typeof(revision)='integer')
);
INSERT INTO human_activation_state(uuid) SELECT uuid FROM user_accounts;
CREATE TRIGGER human_activation_insert AFTER INSERT ON user_accounts BEGIN
    INSERT INTO human_activation_state(uuid) VALUES(NEW.uuid);
END;
CREATE TRIGGER human_activation_update AFTER UPDATE OF is_active ON user_accounts
WHEN OLD.is_active IS NOT NEW.is_active BEGIN
    UPDATE human_activation_state SET revision=revision+1 WHERE uuid=NEW.uuid;
END;
