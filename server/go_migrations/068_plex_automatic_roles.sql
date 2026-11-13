-- The automatic user roles MUM's Flask version had: Downloads, Home User and
-- Shares Back. They are created up front so they appear in User Roles
-- settings, and the user sync keeps their members up to date. Ownership stays
-- explicit: a role someone already created under one of these names is never
-- adopted; the automatic role is then not created.

-- Plex reports download permission (allowSync) like the other services.
ALTER TABLE download_observations RENAME TO download_observations_before068;
CREATE TABLE download_observations (
    service_uuid TEXT PRIMARY KEY,
    server_id INTEGER NOT NULL,
    external_user_id TEXT NOT NULL,
    role_id TEXT NOT NULL REFERENCES download_role(role_id) ON DELETE RESTRICT,
    allowed INTEGER NOT NULL CHECK(allowed IN (0,1)),
    source_revision INTEGER NOT NULL CHECK(source_revision>0 AND typeof(source_revision)='integer'),
    observed_at TEXT NOT NULL,
    provider_type TEXT NOT NULL CHECK(provider_type IN ('romm','jellyfin','emby','kavita','audiobookshelf','komga','plex')),
    FOREIGN KEY(service_uuid,server_id,external_user_id)
        REFERENCES service_accounts(uuid,server_id,external_user_id) ON DELETE CASCADE
);
INSERT INTO download_observations(service_uuid,server_id,external_user_id,role_id,allowed,source_revision,observed_at,provider_type)
SELECT service_uuid,server_id,external_user_id,role_id,allowed,source_revision,observed_at,provider_type
FROM download_observations_before068;
DROP TABLE download_observations_before068;

-- Registry of the relationship roles the Plex sync owns.
CREATE TABLE relationship_roles (
    kind TEXT PRIMARY KEY CHECK(kind IN ('home_user','shares_back')),
    role_id TEXT NOT NULL UNIQUE REFERENCES user_roles(id) ON DELETE RESTRICT
);

CREATE TEMP TABLE automatic_role_seed(kind TEXT PRIMARY KEY, id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, color TEXT NOT NULL, icon TEXT NOT NULL, seq INTEGER NOT NULL);
INSERT INTO automatic_role_seed(kind,id,name,description,color,icon,seq)
SELECT kind,
       lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-'||substr('89ab',1+abs(random())%4,1)||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))),
       name,description,color,icon,seq
FROM (SELECT 'downloads' AS kind,'Downloads' AS name,'Last explicitly observed provider download permission; not proof of current access.' AS description,'#3b82f6' AS color,'fa-solid fa-download' AS icon,1 AS seq
      UNION ALL SELECT 'home_user','Home User','Plex Home User with managed access','#a855f7','fa-solid fa-house',2
      UNION ALL SELECT 'shares_back','Shares Back','User shares their library back with you','#22c55e','fa-solid fa-share',3);

-- Downloads may already exist (created by an earlier sync); keep it.
DELETE FROM automatic_role_seed WHERE kind='downloads' AND EXISTS(SELECT 1 FROM download_role);
-- Never take over a role someone created under the same name.
DELETE FROM automatic_role_seed WHERE EXISTS(SELECT 1 FROM user_roles r WHERE lower(r.name)=lower(automatic_role_seed.name));

INSERT INTO user_roles(id,name,description,position,color,icon,badge_style,is_auto_managed)
SELECT id,name,description,(SELECT coalesce(max(position),0) FROM user_roles)+seq,color,icon,'default',1
FROM automatic_role_seed ORDER BY seq;
INSERT INTO download_role(singleton,role_id) SELECT 1,id FROM automatic_role_seed WHERE kind='downloads';
INSERT INTO relationship_roles(kind,role_id) SELECT kind,id FROM automatic_role_seed WHERE kind IN ('home_user','shares_back');
DROP TABLE automatic_role_seed;
