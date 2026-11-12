ALTER TABLE provisioning_jobs ADD COLUMN review_actor_uuid TEXT REFERENCES user_accounts(uuid);
ALTER TABLE provisioning_jobs ADD COLUMN review_access_hash TEXT CHECK(review_access_hash IS NULL OR length(review_access_hash)=64);
ALTER TABLE provisioning_jobs ADD COLUMN review_role_revision INTEGER CHECK(review_role_revision IS NULL OR (review_role_revision>0 AND typeof(review_role_revision)='integer'));
-- Existing claims remain unattributed and cannot authorize further work. Normal
-- explicit finish/restart recovery retains uncertain outcomes and clears claims.
