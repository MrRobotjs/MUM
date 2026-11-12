CREATE TABLE profile_note_state (
    uuid TEXT PRIMARY KEY REFERENCES identities(uuid) ON DELETE CASCADE,
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0 AND typeof(revision)='integer')
);
INSERT INTO profile_note_state(uuid) SELECT uuid FROM identities;
CREATE TRIGGER profile_note_identity_insert AFTER INSERT ON identities BEGIN
    INSERT INTO profile_note_state(uuid) VALUES(NEW.uuid);
END;
CREATE TRIGGER profile_note_user_update AFTER UPDATE OF notes ON user_accounts
WHEN OLD.notes IS NOT NEW.notes BEGIN
    UPDATE profile_note_state SET revision=revision+1 WHERE uuid=NEW.uuid;
END;
CREATE TRIGGER profile_note_service_update AFTER UPDATE OF notes ON service_accounts
WHEN OLD.notes IS NOT NEW.notes BEGIN
    UPDATE profile_note_state SET revision=revision+1 WHERE uuid=NEW.uuid;
END;
