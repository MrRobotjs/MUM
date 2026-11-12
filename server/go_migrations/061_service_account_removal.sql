-- When an account disappears from its provider during a user sync (for example
-- a user who left a Plex server), it is marked removed instead of deleted: it
-- is hidden from the Users list while its record, links and activity history
-- are kept, and it is restored if it comes back or is invited again.
-- NULL means present. Existing rows start present; the next sync marks any
-- missing ones.
ALTER TABLE service_accounts ADD COLUMN removed_at TEXT;
