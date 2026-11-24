-- Remove storage used only by the retired legacy snapshot importer.
DROP TABLE legacy_records;
DROP TABLE import_runs;
ALTER TABLE user_accounts DROP COLUMN legacy_metadata;
ALTER TABLE service_accounts DROP COLUMN legacy_metadata;
