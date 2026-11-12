-- Widen the typed provenance domain without changing registered ownership.
ALTER TABLE download_observations RENAME TO download_observations_before038;
CREATE TABLE download_observations (
    service_uuid TEXT PRIMARY KEY,
    server_id INTEGER NOT NULL,
    external_user_id TEXT NOT NULL,
    role_id TEXT NOT NULL REFERENCES download_role(role_id) ON DELETE RESTRICT,
    allowed INTEGER NOT NULL CHECK(allowed IN (0,1)),
    source_revision INTEGER NOT NULL CHECK(source_revision>0 AND typeof(source_revision)='integer'),
    observed_at TEXT NOT NULL,
    provider_type TEXT NOT NULL CHECK(provider_type IN ('romm','jellyfin','emby','kavita','audiobookshelf','komga')),
    FOREIGN KEY(service_uuid,server_id,external_user_id)
        REFERENCES service_accounts(uuid,server_id,external_user_id) ON DELETE CASCADE
);
INSERT INTO download_observations(service_uuid,server_id,external_user_id,role_id,allowed,source_revision,observed_at,provider_type)
SELECT service_uuid,server_id,external_user_id,role_id,allowed,source_revision,observed_at,provider_type
FROM download_observations_before038;
DROP TABLE download_observations_before038;
