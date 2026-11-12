-- Carry forward explicit registry ownership; never discover roles by name.
ALTER TABLE romm_download_role_state RENAME TO download_role_state;
ALTER TABLE romm_download_role RENAME TO download_role;
ALTER TABLE romm_download_observations RENAME TO download_observations;
ALTER TABLE download_observations ADD COLUMN provider_type TEXT NOT NULL DEFAULT 'romm'
    CHECK(provider_type IN ('romm','jellyfin','emby'));
DROP TRIGGER romm_download_role_insert;
DROP TRIGGER romm_download_role_update;
DROP TRIGGER romm_download_role_delete;
DROP TRIGGER romm_download_definition_update;
CREATE TRIGGER download_role_insert AFTER INSERT ON download_role BEGIN
    UPDATE download_role_state SET revision=revision+1;
END;
CREATE TRIGGER download_role_update AFTER UPDATE ON download_role BEGIN
    UPDATE download_role_state SET revision=revision+1;
END;
CREATE TRIGGER download_role_delete AFTER DELETE ON download_role BEGIN
    UPDATE download_role_state SET revision=revision+1;
END;
CREATE TRIGGER download_definition_update AFTER UPDATE ON user_roles
WHEN EXISTS(SELECT 1 FROM download_role WHERE role_id=OLD.id OR role_id=NEW.id) BEGIN
    UPDATE download_role_state SET revision=revision+1;
END;
UPDATE user_roles SET description='Last explicitly observed provider download permission; not proof of current access.'
WHERE id IN (SELECT role_id FROM download_role) AND name='Downloads' AND is_auto_managed=1
AND description='Last explicitly observed RomM download permission; not proof of current access.';
