CREATE TABLE human_credential_state (
    uuid TEXT PRIMARY KEY REFERENCES user_accounts(uuid) ON DELETE CASCADE,
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0 AND typeof(revision)='integer')
);
INSERT INTO human_credential_state(uuid) SELECT uuid FROM user_accounts;
CREATE TRIGGER human_credential_insert AFTER INSERT ON user_accounts BEGIN
    INSERT INTO human_credential_state(uuid) VALUES(NEW.uuid);
END;
CREATE TRIGGER human_credential_update AFTER UPDATE OF password_hash,local_username,force_password_change ON user_accounts
WHEN NEW.password_hash IS NOT OLD.password_hash OR NEW.local_username IS NOT OLD.local_username OR NEW.force_password_change IS NOT OLD.force_password_change BEGIN
    UPDATE human_credential_state SET revision=revision+1 WHERE uuid=NEW.uuid;
END;
