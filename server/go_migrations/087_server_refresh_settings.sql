-- Per-server preferences and independently tracked users/library jobs.
CREATE TABLE server_refresh_settings (
 server_id INTEGER PRIMARY KEY REFERENCES media_servers(id) ON DELETE CASCADE,
 include_episodes INTEGER NOT NULL DEFAULT 1 CHECK(include_episodes IN (0,1)),
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0)
);
CREATE TABLE server_refresh_schedules (
 server_id INTEGER NOT NULL REFERENCES media_servers(id) ON DELETE CASCADE,
 scope TEXT NOT NULL CHECK(scope IN ('users','libraries')),
 interval_seconds INTEGER NOT NULL DEFAULT 3600 CHECK(interval_seconds BETWEEN 3600 AND 31536000),
 refresh_on_startup INTEGER NOT NULL DEFAULT 1 CHECK(refresh_on_startup IN (0,1)),
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
 next_run_at TEXT,
 run_state TEXT NOT NULL DEFAULT 'idle' CHECK(run_state IN ('idle','running','succeeded','failed','cancelled','interrupted')),
 claim_token TEXT,
 runner_id TEXT,
 lease_until TEXT,
 started_at TEXT,
 finished_at TEXT,
 last_code TEXT NOT NULL DEFAULT 'NEVER_RUN',
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
 PRIMARY KEY(server_id,scope),
 CHECK((run_state='running' AND claim_token IS NOT NULL AND runner_id IS NOT NULL AND lease_until IS NOT NULL) OR (run_state<>'running' AND claim_token IS NULL AND runner_id IS NULL AND lease_until IS NULL))
);
CREATE INDEX server_refresh_due ON server_refresh_schedules(next_run_at,server_id,scope);
INSERT INTO server_refresh_settings(server_id) SELECT id FROM media_servers;
INSERT INTO server_refresh_schedules(server_id,scope) SELECT id,'users' FROM media_servers;
INSERT INTO server_refresh_schedules(server_id,scope) SELECT id,'libraries' FROM media_servers;
CREATE TRIGGER create_server_refresh AFTER INSERT ON media_servers BEGIN
 INSERT INTO server_refresh_settings(server_id) VALUES(NEW.id);
 INSERT INTO server_refresh_schedules(server_id,scope) VALUES(NEW.id,'users');
 INSERT INTO server_refresh_schedules(server_id,scope) VALUES(NEW.id,'libraries');
END;
