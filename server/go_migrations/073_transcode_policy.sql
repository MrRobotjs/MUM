-- 4K transcoding policy (user decision 2026-11-15). A server account with
-- allow_4k_transcode=0 has its streams stopped when the server transcodes a
-- 4K source. Each playback is stopped at most once: the attempt is recorded
-- before the server is asked, so a failed or uncertain stop is never repeated,
-- even after a restart.
CREATE TABLE transcode_policy_stops (
 history_id INTEGER PRIMARY KEY REFERENCES media_activity_history(id) ON DELETE CASCADE,
 attempted_at TEXT NOT NULL,
 outcome TEXT NOT NULL CHECK(outcome IN ('pending','terminated','already_ended','refused','failed'))
);

-- Invitations choose 4K transcoding per server; existing grants allow it.
ALTER TABLE invitation_grants ADD COLUMN allow_4k_transcode INTEGER NOT NULL DEFAULT 1 CHECK(allow_4k_transcode IN (0,1));
