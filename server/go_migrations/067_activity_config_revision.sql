-- Stream readings are now tied to the server's settings revision (URL, API key,
-- enabled) instead of its general revision, which every sync raises. Account
-- changes stay covered by mapping_revision. Readings taken under the old rule
-- are cleared so the next poll records the new one.
ALTER TABLE media_activity_state RENAME COLUMN observed_server_revision TO observed_config_revision;
UPDATE media_activity_state SET observed_config_revision=NULL;
