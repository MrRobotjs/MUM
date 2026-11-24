package main

import (
	"database/sql"
	"path/filepath"
	"testing"
)

func TestTofaMigrationPreservesServerDependants(t *testing.T) {
	path := filepath.Join(t.TempDir(), "app.sqlite")
	db, err := sql.Open("sqlite", sqliteDSN(path, false))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`CREATE TABLE schema_migrations(version TEXT PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"001_baseline.sql", "002_remove_legacy_import.sql", "003_image_cache_settings.sql", "004_history_realtime.sql"} {
		body, e := migrationFiles.ReadFile("go_migrations/" + name)
		if e != nil {
			t.Fatal(e)
		}
		if _, e = db.Exec(string(body)); e != nil {
			t.Fatal(e)
		}
		if _, e = db.Exec(`INSERT INTO schema_migrations VALUES(?,?,?)`, name, migrationChecksum(body), "now"); e != nil {
			t.Fatal(e)
		}
	}
	if _, err = db.Exec(`INSERT INTO media_servers(id,server_nickname,service_type,url) VALUES(1,'Existing','plex','http://fixture.invalid')`); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`INSERT INTO media_libraries(server_id,external_id,name) VALUES(1,'movies','Movies'); INSERT INTO identities(uuid,kind) VALUES('fixture-service','service'); INSERT INTO service_accounts(uuid,server_id,external_user_id,external_username,created_at,updated_at) VALUES('fixture-service',1,'reader','Reader','2026','2026')`); err != nil {
		t.Fatal(err)
	}
	var namespace string
	if err = db.QueryRow(`SELECT namespace FROM image_cache_server_identity WHERE server_id=1`).Scan(&namespace); err != nil {
		t.Fatal(err)
	}
	if err = db.Close(); err != nil {
		t.Fatal(err)
	}
	s, err := OpenStore(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var name, got string
	var schedules int
	if err = s.reader.QueryRow(`SELECT server_nickname,namespace,(SELECT count(*) FROM server_refresh_schedules WHERE server_id=1) FROM media_servers JOIN image_cache_server_identity ON server_id=media_servers.id WHERE id=1`).Scan(&name, &got, &schedules); err != nil {
		t.Fatal(err)
	}
	if name != "Existing" || got != namespace || schedules != 2 {
		t.Fatal(name, got, schedules)
	}
	var libraries, accounts int
	if err = s.reader.QueryRow(`SELECT (SELECT count(*) FROM media_libraries WHERE server_id=1),(SELECT count(*) FROM service_accounts WHERE server_id=1)`).Scan(&libraries, &accounts); err != nil || libraries != 1 || accounts != 1 {
		t.Fatal("dependent data lost", libraries, accounts, err)
	}
	var fk int
	if err = s.writer.QueryRow(`PRAGMA foreign_keys`).Scan(&fk); err != nil || fk != 1 {
		t.Fatal("writer FK enforcement", fk, err)
	}
	if _, err = s.writer.Exec(`INSERT INTO media_servers(server_nickname,service_type,url) VALUES('Tofa','tofa','http://fixture.invalid')`); err != nil {
		t.Fatal(err)
	}
	if err = s.CheckIntegrity(t.Context()); err != nil {
		t.Fatal(err)
	}
}
