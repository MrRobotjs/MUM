package main

import (
	"database/sql"
	"testing"
)

func TestProviderNicknameMigrationPreservesReferencedServerData(t *testing.T) {
	db, path := databaseBefore(t, "094")
	for _, q := range []string{
		`INSERT INTO media_servers(id,server_nickname,service_type,url) VALUES(1,'Shared','plex','http://fixture.invalid')`,
		`UPDATE server_sync_schedules SET interval_seconds=7200 WHERE server_id=1`,
		`INSERT INTO media_libraries(server_id,external_id,name,library_type) VALUES(1,'fixture','Fixture','movie')`,
	} {
		if _, err := db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	s, err := OpenStore(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var interval, count int
	if err = s.reader.QueryRow(`SELECT interval_seconds FROM server_sync_schedules WHERE server_id=1`).Scan(&interval); err != nil || interval != 7200 {
		t.Fatalf("schedule: %d %v", interval, err)
	}
	if err = s.reader.QueryRow(`SELECT count(*) FROM media_libraries WHERE server_id=1 AND external_id='fixture'`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("library: %d %v", count, err)
	}
	if _, err = s.writer.Exec(`INSERT INTO media_servers(server_nickname,service_type,url) VALUES('Shared','jellyfin','http://fixture.invalid')`); err != nil {
		t.Fatalf("cross-provider duplicate: %v", err)
	}
	var foreignKeys int
	if err = s.writer.QueryRow(`PRAGMA foreign_keys`).Scan(&foreignKeys); err != nil || foreignKeys != 1 {
		t.Fatalf("foreign key enforcement: %d %v", foreignKeys, err)
	}
	if _, err = s.writer.Exec(`INSERT INTO media_libraries(server_id,external_id,name,library_type) VALUES(999,'orphan','Orphan','movie')`); err == nil {
		t.Fatal("foreign keys not enforced")
	}
	if err = s.reader.QueryRow(`SELECT count(*) FROM server_refresh_settings WHERE server_id=(SELECT id FROM media_servers WHERE service_type='jellyfin' AND server_nickname='Shared')`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("insert trigger: %d %v", count, err)
	}
	if err = s.CheckIntegrity(t.Context()); err != nil {
		t.Fatal(err)
	}
}

func TestProviderNicknameMigrationRollsBackOnForeignKeyViolation(t *testing.T) {
	db, path := databaseBefore(t, "094")
	for _, q := range []string{`PRAGMA foreign_keys=OFF`, `INSERT INTO media_libraries(server_id,external_id,name,library_type) VALUES(999,'orphan','Orphan','movie')`} {
		if _, err := db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	if store, err := OpenStore(t.Context(), path); err == nil {
		store.Close()
		t.Fatal("migration accepted orphan")
	}
	db, err := sql.Open("sqlite", sqliteDSN(path, false))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var count int
	if err = db.QueryRow(`SELECT count(*) FROM schema_migrations WHERE version='094_provider_server_nicknames.sql'`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("migration record: %d %v", count, err)
	}
	if err = db.QueryRow(`SELECT count(*) FROM media_libraries WHERE server_id=999`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("orphan row changed: %d %v", count, err)
	}
	if _, err = db.Exec(`INSERT INTO media_servers(server_nickname,service_type,url) VALUES('Same','plex','http://fixture.invalid'),('Same','jellyfin','http://fixture.invalid')`); err == nil {
		t.Fatal("original unique constraint was not restored")
	}
}
