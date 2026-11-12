-- Client application, device name and delivery mode last reported for an
-- observation (Jellyfin/Emby SessionInfo.Client, DeviceName and
-- PlayState.PlayMethod). NULL means unknown, including every observation
-- recorded before this migration. Device names are never returned directly.
ALTER TABLE media_activity_history ADD COLUMN client TEXT CHECK(client IS NULL OR length(client) BETWEEN 1 AND 128);
ALTER TABLE media_activity_history ADD COLUMN device_name TEXT CHECK(device_name IS NULL OR length(device_name) BETWEEN 1 AND 256);
ALTER TABLE media_activity_history ADD COLUMN play_method TEXT CHECK(play_method IS NULL OR play_method IN ('direct_play','direct_stream','transcode'));
