CREATE TABLE activity_monitor_schedules(
 server_id INTEGER PRIMARY KEY REFERENCES media_servers(id) ON DELETE CASCADE,
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
 interval_seconds INTEGER NOT NULL DEFAULT 30 CHECK(interval_seconds BETWEEN 15 AND 3600),
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
 configured_server_revision INTEGER,
 authorized_by TEXT REFERENCES user_accounts(uuid),
 next_run_at TEXT,
 run_state TEXT NOT NULL DEFAULT 'idle' CHECK(run_state IN ('idle','running','succeeded','failed','cancelled','interrupted')),
 claim_token TEXT,
 runner_id TEXT,
 lease_until TEXT,
 started_at TEXT,
 finished_at TEXT,
 last_code TEXT NOT NULL DEFAULT 'NEVER_RUN',
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
 CHECK((run_state='running' AND claim_token IS NOT NULL AND runner_id IS NOT NULL AND lease_until IS NOT NULL) OR (run_state<>'running' AND claim_token IS NULL AND runner_id IS NULL AND lease_until IS NULL)),
 CHECK(enabled=0 OR (authorized_by IS NOT NULL AND configured_server_revision IS NOT NULL AND next_run_at IS NOT NULL))
);
CREATE INDEX activity_monitor_due ON activity_monitor_schedules(enabled,run_state,next_run_at);
INSERT INTO activity_monitor_schedules(server_id) SELECT server_id FROM media_activity_state;
CREATE TRIGGER create_activity_monitor AFTER INSERT ON media_activity_state BEGIN
 INSERT INTO activity_monitor_schedules(server_id) VALUES(NEW.server_id);
END;
