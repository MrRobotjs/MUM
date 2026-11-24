CREATE TABLE image_cache_settings (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 mode TEXT NOT NULL DEFAULT 'shared' CHECK(mode IN ('shared','per_server')),
 shared_limit_mb INTEGER NOT NULL DEFAULT 1024 CHECK(shared_limit_mb BETWEEN 1 AND 1048576),
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0)
);
INSERT INTO image_cache_settings(singleton) VALUES(1);
CREATE TABLE image_cache_server_limits (
 server_id INTEGER PRIMARY KEY REFERENCES media_servers(id) ON DELETE CASCADE,
 limit_mb INTEGER NOT NULL DEFAULT 1024 CHECK(limit_mb BETWEEN 1 AND 1048576)
);
CREATE TABLE image_cache_server_identity (
 server_id INTEGER PRIMARY KEY REFERENCES media_servers(id) ON DELETE CASCADE,
 namespace TEXT NOT NULL UNIQUE CHECK(length(namespace)=32)
);
INSERT INTO image_cache_server_identity(server_id,namespace)
 SELECT id,lower(hex(randomblob(16))) FROM media_servers;
CREATE TRIGGER image_cache_server_identity_create AFTER INSERT ON media_servers BEGIN
 INSERT INTO image_cache_server_identity(server_id,namespace) VALUES(NEW.id,lower(hex(randomblob(16))));
END;
CREATE INDEX history_imports_server_item ON history_imports(server_id,item_id,library_id);
