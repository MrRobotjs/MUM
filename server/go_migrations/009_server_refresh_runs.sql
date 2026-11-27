-- The log of each scheduled server refresh: when it ran, how it ended and
-- what it did, as an ordered list of {level, message, detail} entries. The
-- most recent runs of each server and scope are kept.
CREATE TABLE server_refresh_runs (
 id INTEGER PRIMARY KEY,
 server_id INTEGER NOT NULL REFERENCES media_servers(id) ON DELETE CASCADE,
 scope TEXT NOT NULL CHECK(scope IN ('users','libraries')),
 started_at TEXT NOT NULL,
 finished_at TEXT NOT NULL,
 outcome TEXT NOT NULL CHECK(outcome IN ('succeeded','warnings','failed','cancelled')),
 entries TEXT NOT NULL CHECK(json_valid(entries) AND json_type(entries)='array' AND length(entries)<=65536)
);
CREATE INDEX server_refresh_runs_task ON server_refresh_runs(server_id,scope,id);
