-- Deleting a local account from the Users list retires it instead of removing
-- its row: jobs, audit events and activity history keep referring to it. A
-- retired account cannot sign in, is unlinked and hidden, and its username is
-- freed for reuse; deleted_username keeps the former name for history labels.
ALTER TABLE user_accounts ADD COLUMN deleted_at TEXT;
ALTER TABLE user_accounts ADD COLUMN deleted_username TEXT;
