package main

import (
	"crypto/sha256"
	"database/sql"
	"fmt"
	"path/filepath"
	"testing"
	"time"
)

// An ordinary users/libraries sync bumps the content revision. It must not
// silently revoke the owner's activity-monitoring consent.
func TestOrdinarySyncPreservesMonitoringConsent(t *testing.T) {
	upstream, _ := providerFixture(t, "jellyfin")
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	owner, _ := s.Authenticate(t.Context(), token)
	server := createManagedServer(t, a, token, "jellyfin", upstream.URL)
	configureTestMonitor(t, a, token, server, true)
	snapshot, err := a.loadServer(t.Context(), server)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a.syncServer(t.Context(), owner.UUID, token, snapshot, true, true); err != nil {
		t.Fatal("sync", err)
	}
	claim, err := a.claimActivityMonitor(t.Context())
	if err != nil || claim == nil {
		t.Fatal("ordinary sync revoked monitoring consent", err)
	}
	if task := monitorSnapshot(t, a, token)["tasks"].([]any)[0].(map[string]any); task["state"] == "paused" || task["enabled"] != true {
		t.Fatal("task reported ineligible after sync", task)
	}
}

// Each configuration input, including provider enablement, revokes consent.
// Nickname/public URL edits and unchanged writes do not.
func TestServerConfigRevisionTriggers(t *testing.T) {
	_, s := testApp(t)
	id := seedServer(t, s)
	read := func() int64 {
		t.Helper()
		var value int64
		if err := s.reader.QueryRow("SELECT config_revision FROM media_servers WHERE id=?", id).Scan(&value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	for _, tc := range []struct {
		query string
		bump  bool
	}{
		{"UPDATE media_servers SET revision=revision+1,last_sync_at='x' WHERE id=?", false},
		{"UPDATE media_servers SET server_nickname='renamed',public_url='https://public.invalid' WHERE id=?", false},
		{"UPDATE media_servers SET url=url WHERE id=?", false},
		{"UPDATE media_servers SET url='http://other.invalid' WHERE id=?", true},
		{"UPDATE media_servers SET api_key='rotated' WHERE id=?", true},
		{"UPDATE media_servers SET is_active=0 WHERE id=?", true},
		{"UPDATE provider_settings SET enabled=0 WHERE provider_id='jellyfin' AND ?>0", true},
		{"UPDATE provider_settings SET enabled=0 WHERE provider_id='jellyfin' AND ?>0", false},
	} {
		before := read()
		activityExec(t, s, tc.query, id)
		if changed := read() != before; changed != tc.bump {
			t.Fatal(tc.query, "changed", changed)
		}
	}
}

// Migration 044 keeps currently valid consent and fails closed for consent an
// earlier content bump had already orphaned.
func TestServerConfigRevisionMigrationCarriesOnlyValidConsent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mum.db")
	db, err := sql.Open("sqlite", sqliteDSN(path, false))
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	if _, err = db.Exec("PRAGMA foreign_keys=ON"); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec("CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)"); err != nil {
		t.Fatal(err)
	}
	files, err := migrationFiles.ReadDir("go_migrations")
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range files {
		if file.Name() >= "044" {
			break
		}
		body, err := migrationFiles.ReadFile("go_migrations/" + file.Name())
		if err != nil {
			t.Fatal(err)
		}
		if _, err = db.Exec(string(body)); err != nil {
			t.Fatal(file.Name(), err)
		}
		if _, err = db.Exec("INSERT INTO schema_migrations VALUES(?,?,?)", file.Name(), fmt.Sprintf("%x", sha256.Sum256(body)), utcTimestamp(time.Now())); err != nil {
			t.Fatal(err)
		}
	}
	for _, statement := range []string{
		"INSERT INTO media_servers(id,server_nickname,service_type,url,revision) VALUES(1,'valid','jellyfin','http://valid.invalid',5),(2,'orphaned','emby','http://orphan.invalid',9)",
		"UPDATE activity_monitor_schedules SET configured_server_revision=CASE server_id WHEN 1 THEN 5 ELSE 7 END",
	} {
		if _, err = db.Exec(statement); err != nil {
			t.Fatal(statement, err)
		}
	}
	if err = db.Close(); err != nil {
		t.Fatal(err)
	}
	s, err := OpenStore(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	rows, err := s.reader.Query("SELECT q.server_id,q.configured_server_revision=s.config_revision,s.revision FROM activity_monitor_schedules q JOIN media_servers s ON s.id=q.server_id ORDER BY q.server_id")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	want := map[int64]bool{1: true, 2: false}
	seen := 0
	for rows.Next() {
		var server, revision int64
		var valid bool
		if err := rows.Scan(&server, &valid, &revision); err != nil {
			t.Fatal(err)
		}
		if valid != want[server] || revision != map[int64]int64{1: 5, 2: 9}[server] {
			t.Fatal("server", server, "valid", valid, "revision", revision)
		}
		seen++
	}
	if err := rows.Err(); err != nil || seen != 2 {
		t.Fatal(seen, err)
	}
	if err := s.CheckIntegrity(t.Context()); err != nil {
		t.Fatal(err)
	}
}
