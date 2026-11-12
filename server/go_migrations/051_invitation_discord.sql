-- Invitation-bound Discord sign-in proofs. Only digests of the OAuth state and
-- the browser secret are stored; Discord user tokens are never persisted.
UPDATE invites SET require_discord_auth=coalesce(require_discord_auth,0),require_discord_guild_membership=coalesce(require_discord_guild_membership,0);
CREATE TABLE invitation_discord_proofs(
 id TEXT PRIMARY KEY,
 invite_id INTEGER NOT NULL REFERENCES invites(id) ON DELETE CASCADE,
 invitation_revision INTEGER NOT NULL CHECK(invitation_revision>0),
 settings_revision INTEGER NOT NULL CHECK(settings_revision>0),
 require_guild INTEGER NOT NULL CHECK(require_guild IN (0,1)),
 state_hash TEXT NOT NULL UNIQUE,
 browser_hash TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','exchanging','verified','consumed','failed')),
 error_code TEXT CHECK(error_code IS NULL OR length(error_code) BETWEEN 1 AND 64),
 discord_user_id TEXT CHECK(discord_user_id IS NULL OR (length(discord_user_id) BETWEEN 17 AND 20 AND discord_user_id NOT GLOB '*[^0-9]*')),
 discord_username TEXT CHECK(discord_username IS NULL OR length(discord_username) BETWEEN 1 AND 64),
 discord_avatar TEXT CHECK(discord_avatar IS NULL OR length(discord_avatar) BETWEEN 1 AND 64),
 guild_verified INTEGER CHECK(guild_verified IS NULL OR guild_verified IN (0,1)),
 job_id TEXT REFERENCES provisioning_jobs(id),
 created_at TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 CHECK(status NOT IN ('verified','consumed') OR (discord_user_id IS NOT NULL AND discord_username IS NOT NULL)),
 CHECK(status<>'verified' OR require_guild=0 OR guild_verified=1),
 CHECK((status='consumed')=(job_id IS NOT NULL))
);
CREATE INDEX invitation_discord_proofs_invite ON invitation_discord_proofs(invite_id,status);
-- One MUM profile per Discord account.
CREATE UNIQUE INDEX user_accounts_discord_identity ON user_accounts(discord_user_id) WHERE discord_user_id IS NOT NULL;
