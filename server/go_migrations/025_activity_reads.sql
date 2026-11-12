CREATE INDEX activity_history_owner_cursor ON media_activity_history(owner_uuid,id DESC);
CREATE INDEX activity_history_server_cursor ON media_activity_history(server_id,id DESC);
