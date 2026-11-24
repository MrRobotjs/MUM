package main

import (
	"database/sql"
	"fmt"
	"net/http"
	"path/filepath"
	"testing"
)

func TestImageCacheSettingsDefaultAndIndependentLimits(t *testing.T) {
	a, _ := testApp(t)
	token, _ := bootstrapOwner(t, a)
	server := createManagedServer(t, a, token, "plex", "http://127.0.0.1:1")
	w := apiRequest(a, http.MethodGet, "/api/settings/image-cache", token, nil, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	data := responseData(t, w)
	if data["mode"] != "shared" || data["shared_limit_mb"] != float64(1024) {
		t.Fatal(data)
	}
	rev := data["revision"]
	w = apiRequest(a, http.MethodPut, "/api/settings/image-cache", token, map[string]any{"revision": rev, "mode": "per_server", "shared_limit_mb": 2048}, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	rev = responseData(t, w)["revision"]
	w = apiRequest(a, http.MethodPut, fmt.Sprintf("/api/servers/%d/image-cache/limit", server), token, map[string]any{"revision": rev, "limit_mb": 512}, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	w = apiRequest(a, http.MethodGet, "/api/settings/image-cache", token, nil, nil)
	data = responseData(t, w)
	if data["mode"] != "per_server" || data["shared_limit_mb"] != float64(2048) || data["servers"].([]any)[0].(map[string]any)["limit_mb"] != float64(512) {
		t.Fatal(data)
	}
	if w = apiRequest(a, http.MethodPut, "/api/settings/image-cache", token, map[string]any{"revision": rev, "mode": "shared", "shared_limit_mb": 1}, nil); w.Code != 409 {
		t.Fatal("stale write", w.Code, w.Body.String())
	}
	if w = apiRequest(a, http.MethodGet, "/api/settings/image-cache", "", nil, nil); w.Code != 401 {
		t.Fatal("unauthenticated", w.Code)
	}
	rev = data["revision"]
	w = apiRequest(a, http.MethodPut, "/api/settings/image-cache", token, map[string]any{"revision": rev, "mode": "shared", "shared_limit_mb": 2048}, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	w = apiRequest(a, http.MethodGet, "/api/settings/image-cache", token, nil, nil)
	data = responseData(t, w)
	if data["servers"].([]any)[0].(map[string]any)["limit_mb"] != float64(512) {
		t.Fatal("server limit was lost when changing modes", data)
	}
	if w = apiRequest(a, http.MethodPut, "/api/settings/image-cache", token, map[string]any{"revision": data["revision"], "mode": "shared", "shared_limit_mb": 0}, nil); w.Code != 400 {
		t.Fatal("invalid limit accepted", w.Code)
	}
}

func TestImageCacheSettingsMigrationPreservesExistingServer(t *testing.T) {
	path := filepath.Join(t.TempDir(), "app.sqlite")
	db, err := sql.Open("sqlite", sqliteDSN(path, false))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err = db.Exec(`CREATE TABLE schema_migrations(version TEXT PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"001_baseline.sql", "002_remove_legacy_import.sql"} {
		body, err := migrationFiles.ReadFile("go_migrations/" + name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = db.Exec(string(body)); err != nil {
			t.Fatal(err)
		}
		if _, err = db.Exec(`INSERT INTO schema_migrations VALUES(?,?,?)`, name, migrationChecksum(body), "now"); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = db.Exec(`INSERT INTO media_servers(id,server_nickname,service_type,url) VALUES(1,'Existing','plex','http://fixture.invalid')`); err != nil {
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
	var nickname, namespace, mode string
	var limit int
	if err = s.reader.QueryRow(`SELECT s.server_nickname,c.namespace,g.mode,g.shared_limit_mb FROM media_servers s JOIN image_cache_server_identity c ON c.server_id=s.id CROSS JOIN image_cache_settings g WHERE s.id=1`).Scan(&nickname, &namespace, &mode, &limit); err != nil {
		t.Fatal(err)
	}
	if nickname != "Existing" || len(namespace) != 32 || mode != "shared" || limit != 1024 {
		t.Fatal(nickname, namespace, mode, limit)
	}
	if err = s.CheckIntegrity(t.Context()); err != nil {
		t.Fatal(err)
	}
}

func TestImageCacheSettingsRequireAdministrator(t *testing.T) {
	a, s := testApp(t)
	ownerToken, _ := bootstrapOwner(t, a)
	owner, err := s.Authenticate(t.Context(), ownerToken)
	if err != nil {
		t.Fatal(err)
	}
	user, err := s.CreateAccount(t.Context(), owner.UUID, "cache-user", "fixture-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	session, err := s.issueSession(t.Context(), user, false)
	if err != nil {
		t.Fatal(err)
	}
	for _, request := range []struct {
		method, path string
		body         any
	}{
		{http.MethodGet, "/api/settings/image-cache", nil},
		{http.MethodPut, "/api/settings/image-cache", map[string]any{"revision": 1, "mode": "shared", "shared_limit_mb": 1}},
		{http.MethodPost, "/api/settings/image-cache/clear", nil},
	} {
		w := apiRequest(a, request.method, request.path, session.Access, request.body, nil)
		if w.Code != 403 {
			t.Fatalf("%s %s: %d %s", request.method, request.path, w.Code, w.Body.String())
		}
	}
}

func TestImageCacheServerIdentityChangesWhenIDIsReused(t *testing.T) {
	_, s := testApp(t)
	activityExec(t, s, `INSERT INTO media_servers(id,server_nickname,service_type,url) VALUES(73,'First','plex','http://fixture.invalid')`)
	var first, second string
	if err := s.reader.QueryRow(`SELECT namespace FROM image_cache_server_identity WHERE server_id=73`).Scan(&first); err != nil {
		t.Fatal(err)
	}
	activityExec(t, s, `DELETE FROM media_servers WHERE id=73`)
	activityExec(t, s, `INSERT INTO media_servers(id,server_nickname,service_type,url) VALUES(73,'Second','plex','http://fixture.invalid')`)
	if err := s.reader.QueryRow(`SELECT namespace FROM image_cache_server_identity WHERE server_id=73`).Scan(&second); err != nil {
		t.Fatal(err)
	}
	if first == second || mediaCacheIdentity("plex", "item", first) == mediaCacheIdentity("plex", "item", second) {
		t.Fatal("reused server ID inherited prior cache identity")
	}
}
