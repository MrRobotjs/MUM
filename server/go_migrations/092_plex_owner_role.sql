-- Keep the provider owner label separate from MUM's administrator authority.
-- Do not take over a manually created role with the same name.
CREATE TABLE plex_owner_role (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    role_id TEXT NOT NULL UNIQUE REFERENCES user_roles(id) ON DELETE RESTRICT
);
CREATE TEMP TABLE plex_owner_seed(id TEXT NOT NULL);
INSERT INTO plex_owner_seed(id)
SELECT lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-'||substr('89ab',1+abs(random())%4,1)||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6)))
WHERE NOT EXISTS(SELECT 1 FROM user_roles WHERE lower(name)='owner');
INSERT INTO user_roles(id,name,description,position,color,icon,badge_style,is_auto_managed)
SELECT id,'Owner','Plex media server owner; does not grant MUM permissions.',(SELECT coalesce(max(position),0)+1 FROM user_roles),'#f59e0b','fa-solid fa-crown','outline',1 FROM plex_owner_seed;
INSERT INTO plex_owner_role(singleton,role_id) SELECT 1,id FROM plex_owner_seed;
INSERT INTO identity_user_roles(user_uuid,role_id)
SELECT a.uuid,r.id FROM service_accounts a JOIN media_servers s ON s.id=a.server_id CROSS JOIN plex_owner_seed r
WHERE s.service_type='plex' AND a.external_user_id='1' AND a.removed_at IS NULL
ON CONFLICT DO NOTHING;
DROP TABLE plex_owner_seed;
