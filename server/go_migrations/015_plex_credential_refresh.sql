ALTER TABLE plex_invitation_credentials ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE plex_invitation_credentials ADD COLUMN refresh_token TEXT;
ALTER TABLE plex_invitation_credentials ADD COLUMN refresh_expires_at TEXT;
