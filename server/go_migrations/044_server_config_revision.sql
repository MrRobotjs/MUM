-- Separate connection configuration from content revisions. Ordinary sync,
-- review and finalization bump media_servers.revision to fence stale snapshots;
-- activity-monitoring consent must instead pin only to the configured endpoint,
-- credentials, activation, type and provider enablement.
ALTER TABLE media_servers ADD COLUMN config_revision INTEGER NOT NULL DEFAULT 1 CHECK(config_revision>0 AND typeof(config_revision)='integer');
-- Consent that is currently valid carries over. Consent already orphaned by an
-- earlier content bump cannot be distinguished from a configuration change, so
-- it stays invalid until the owner explicitly re-enables monitoring.
UPDATE activity_monitor_schedules SET configured_server_revision=CASE
 WHEN configured_server_revision=(SELECT revision FROM media_servers s WHERE s.id=activity_monitor_schedules.server_id) THEN 1
 ELSE 0 END
 WHERE configured_server_revision IS NOT NULL;
CREATE TRIGGER server_config_revision AFTER UPDATE OF url,api_key,is_active,service_type ON media_servers
 WHEN OLD.url IS NOT NEW.url OR OLD.api_key IS NOT NEW.api_key OR OLD.is_active IS NOT NEW.is_active OR OLD.service_type IS NOT NEW.service_type
BEGIN
 UPDATE media_servers SET config_revision=config_revision+1 WHERE id=NEW.id;
END;
CREATE TRIGGER provider_config_revision AFTER UPDATE OF enabled ON provider_settings
 WHEN OLD.enabled IS NOT NEW.enabled
BEGIN
 UPDATE media_servers SET config_revision=config_revision+1 WHERE service_type=NEW.provider_id;
END;
