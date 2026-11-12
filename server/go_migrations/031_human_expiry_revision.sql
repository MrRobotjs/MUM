CREATE TABLE human_expiry_state (
    uuid TEXT PRIMARY KEY REFERENCES user_accounts(uuid) ON DELETE CASCADE,
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0 AND typeof(revision)='integer')
);
INSERT INTO human_expiry_state(uuid) SELECT uuid FROM user_accounts;
CREATE TRIGGER human_expiry_insert AFTER INSERT ON user_accounts BEGIN
    INSERT INTO human_expiry_state(uuid) VALUES(NEW.uuid);
END;
CREATE TRIGGER human_expiry_update AFTER UPDATE OF access_expires_at ON user_accounts
WHEN OLD.access_expires_at IS NOT NEW.access_expires_at BEGIN
    UPDATE human_expiry_state SET revision=revision+1 WHERE uuid=NEW.uuid;
END;
