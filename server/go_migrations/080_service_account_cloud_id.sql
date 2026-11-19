-- The account's ID on the provider's own service when the media server uses
-- another one for it: Plex Media Server calls its owner account 1, which MUM
-- keeps for matching plays, while plex.tv (and Flask MUM) know the owner by
-- the plex.tv account ID. Shown on the profile.
-- NULL means the same as external_user_id, or unknown.
ALTER TABLE service_accounts ADD COLUMN external_account_id TEXT CHECK(external_account_id IS NULL OR length(external_account_id) BETWEEN 1 AND 255);
