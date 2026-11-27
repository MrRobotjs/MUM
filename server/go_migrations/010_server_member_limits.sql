-- Set when the server refuses a new member because its account's member
-- limit is reached; cleared by the server's next successful user sync.
ALTER TABLE media_servers ADD COLUMN member_limit_reached INTEGER NOT NULL DEFAULT 0 CHECK(member_limit_reached IN (0,1));
-- Servers an invitee chose to go without because they were full or
-- unavailable when they redeemed: a JSON array of {server_id, reason}.
ALTER TABLE provisioning_jobs ADD COLUMN skipped_servers TEXT CHECK(skipped_servers IS NULL OR (json_valid(skipped_servers) AND json_type(skipped_servers)='array' AND length(skipped_servers)<=4096));
