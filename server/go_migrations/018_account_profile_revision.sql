ALTER TABLE user_accounts ADD COLUMN profile_revision INTEGER NOT NULL DEFAULT 1 CHECK(profile_revision > 0);
