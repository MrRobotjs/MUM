package main

import (
	"database/sql"
	"path/filepath"
	"testing"
)

func TestOldPasswordAndLibraryGrantFormatsRejected(t *testing.T) {
	if verifyPassword(legacyHash(t, "old credential password"), "old credential password") {
		t.Fatal("accepted obsolete PBKDF2 password hash")
	}
	libraries := []userLibraryName{{ExternalID: "provider-id", Name: "Movies"}}
	if names := userLibraryDisplayNames(libraries, []string{"old-internal-id"}, false); len(names) != 1 || names[0] != "Library old-internal-id (name unavailable)" {
		t.Fatalf("old library grant resolved: %v", names)
	}
	_, s := testApp(t)
	server := seedServer(t, s)
	activityExec(t, s, `INSERT INTO media_libraries(server_id,external_id,internal_id,name) VALUES(?,?,?,?)`, server, "provider-id", "old-internal-id", "Movies")
	tx, err := s.reader.BeginTx(t.Context(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if ids, err := resolveEditLibraryIDs(t.Context(), tx, server, []string{"provider-id"}); err != nil || len(ids) != 1 || ids[0] != "provider-id" {
		t.Fatalf("current ID: %v %v", ids, err)
	}
	if _, err := resolveEditLibraryIDs(t.Context(), tx, server, []string{"old-internal-id"}); err == nil {
		t.Fatal("accepted old internal ID as grant")
	}
}

func TestLegacyImportRemovalMigrationPreservesCurrentData(t *testing.T) {
	path := filepath.Join(t.TempDir(), "app.sqlite")
	db, err := sql.Open("sqlite", sqliteDSN(path, false))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	body, err := migrationFiles.ReadFile("go_migrations/001_baseline.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(string(body)); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`CREATE TABLE schema_migrations(version TEXT PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL);
		INSERT INTO schema_migrations VALUES ('001_baseline.sql',?,'now');
		INSERT INTO identities(uuid,kind) VALUES('owner-fixture','owner');
		INSERT INTO user_accounts(uuid,kind,local_username,created_at,updated_at,legacy_metadata) VALUES('owner-fixture','owner','fixture','now','now','{}');
		INSERT INTO media_servers(id,server_nickname,service_type,url) VALUES(1,'fixture','plex','http://fixture.invalid');
		INSERT INTO identities(uuid,kind) VALUES('service-fixture','service');
		INSERT INTO service_accounts(uuid,server_id,external_user_id,created_at,updated_at,legacy_metadata) VALUES('service-fixture',1,'provider-user','now','now','{}');
		INSERT INTO service_links(user_uuid,service_uuid,link_kind,created_at) VALUES('owner-fixture','service-fixture','owner','now');
		INSERT INTO history_import_runs(server_id,state,started_at) VALUES(1,'completed','now');`, migrationChecksum(body)); err != nil {
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
	var removed, metadata, owner, history, service, links int
	if err = s.reader.QueryRow(`SELECT (SELECT count(*) FROM sqlite_schema WHERE name IN ('legacy_records','import_runs')),
		(SELECT count(*) FROM pragma_table_info('user_accounts') WHERE name='legacy_metadata')+(SELECT count(*) FROM pragma_table_info('service_accounts') WHERE name='legacy_metadata'),
		(SELECT count(*) FROM user_accounts WHERE uuid='owner-fixture'), (SELECT count(*) FROM history_import_runs WHERE server_id=1),
		(SELECT count(*) FROM service_accounts WHERE uuid='service-fixture' AND external_user_id='provider-user'),
		(SELECT count(*) FROM service_links WHERE user_uuid='owner-fixture' AND service_uuid='service-fixture')`).Scan(&removed, &metadata, &owner, &history, &service, &links); err != nil {
		t.Fatal(err)
	}
	if removed != 0 || metadata != 0 || owner != 1 || history != 1 || service != 1 || links != 1 {
		t.Fatalf("removed tables=%d columns=%d owner=%d history=%d service=%d links=%d", removed, metadata, owner, history, service, links)
	}
	if err = s.CheckIntegrity(t.Context()); err != nil {
		t.Fatal(err)
	}
}

func TestLastSignInDoesNotInferFromSession(t *testing.T) {
	a, s := testApp(t)
	bootstrapOwner(t, a)
	activityExec(t, s, `UPDATE user_accounts SET last_login_at=NULL WHERE kind='owner'`)
	var last sql.NullString
	if err := s.reader.QueryRow(`SELECT ` + lastSignInSQL("u") + ` FROM user_accounts u WHERE kind='owner'`).Scan(&last); err != nil {
		t.Fatal(err)
	}
	if last.Valid {
		t.Fatalf("inferred last sign-in from session: %s", last.String)
	}
}
