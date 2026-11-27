-- Whether a Plex grant also invites the invitee into the owner's Plex Home.
ALTER TABLE invitation_grants ADD COLUMN invite_to_plex_home INTEGER NOT NULL DEFAULT 0 CHECK(invite_to_plex_home IN (0,1));
