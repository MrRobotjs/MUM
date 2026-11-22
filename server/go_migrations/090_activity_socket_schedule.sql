DROP TRIGGER create_activity_monitor;
CREATE TABLE activity_monitor_schedules_new(
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
 socket_enabled INTEGER NOT NULL DEFAULT 0 CHECK(socket_enabled IN (0,1)),
 socket_revision INTEGER NOT NULL DEFAULT 1 CHECK(socket_revision>0),
 socket_pending INTEGER NOT NULL DEFAULT 0 CHECK(socket_pending IN (0,1)),
 CHECK((run_state='running' AND claim_token IS NOT NULL AND runner_id IS NOT NULL AND lease_until IS NOT NULL) OR (run_state<>'running' AND claim_token IS NULL AND runner_id IS NULL AND lease_until IS NULL)),
 CHECK(enabled=0 OR (authorized_by IS NOT NULL AND configured_server_revision IS NOT NULL))
);
INSERT INTO activity_monitor_schedules_new SELECT server_id,enabled,interval_seconds,revision,configured_server_revision,authorized_by,next_run_at,run_state,claim_token,runner_id,lease_until,started_at,finished_at,last_code,attempts,socket_enabled,socket_revision,socket_pending FROM activity_monitor_schedules;
DROP TABLE activity_monitor_schedules;
ALTER TABLE activity_monitor_schedules_new RENAME TO activity_monitor_schedules;
CREATE INDEX activity_monitor_due ON activity_monitor_schedules(enabled,run_state,next_run_at);
CREATE TRIGGER create_activity_monitor AFTER INSERT ON media_activity_state BEGIN
 INSERT INTO activity_monitor_schedules(server_id) VALUES(NEW.server_id);
END;
