-- Ephemeral, allowlisted presentation data for current administrative streams.
ALTER TABLE media_activity_current ADD COLUMN display_json TEXT NOT NULL DEFAULT '{}'
 CHECK(json_valid(display_json) AND length(display_json)<=16384);
