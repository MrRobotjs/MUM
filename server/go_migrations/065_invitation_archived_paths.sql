-- Archiving an invitation releases its custom path so a new invitation can
-- use it. The path it had is kept in archived_custom_path for display.
ALTER TABLE invites ADD COLUMN archived_custom_path TEXT;
UPDATE invites SET archived_custom_path=custom_path,custom_path=NULL WHERE archived_at IS NOT NULL AND custom_path IS NOT NULL;
