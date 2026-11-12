package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func providerFixture(t *testing.T, kind string) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	mode := &atomic.Int32{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := r.Header.Get("X-Emby-Token")
		prefix := ""
		if kind == "emby" {
			prefix = "/emby"
		}
		if kind == "kavita" {
			prefix = "/api"
			key = r.Header.Get("x-api-key")
		}
		if key != "fixture-secret" {
			http.Error(w, "private fixture key rejected", 401)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch strings.TrimPrefix(r.URL.Path, prefix) {
		case "/System/Info":
			if mode.Load() == 4 {
				http.Error(w, "private fixture failure", 503)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]string{"ServerName": "Fixture", "Version": "1.0"})
		case "/Library/VirtualFolders":
			if mode.Load() == 3 {
				fmt.Fprint(w, `[{"ItemId":"same","Name":"One"},{"ItemId":"same","Name":"Two"}]`)
				return
			}
			fmt.Fprint(w, `[{"ItemId":"movies","Name":"Movies","CollectionType":"movies"}]`)
		case "/Library/libraries":
			fmt.Fprint(w, `[{"id":2,"name":"Books","type":2}]`)
		case "/Users":
			if mode.Load() == 1 {
				http.Error(w, "fixture-secret must never reach browser", 500)
				return
			}
			if mode.Load() == 2 {
				fmt.Fprint(w, `[]`)
				return
			}
			if kind == "kavita" {
				fmt.Fprint(w, `[{"id":7,"username":"Reader","email":"reader@example.invalid","isPending":false,"roles":["Pleb","Login"],"libraries":[{"id":2}]}]`)
			} else {
				fmt.Fprint(w, `[{"Id":"reader","Name":"Reader","Policy":{"IsDisabled":false,"EnableAllFolders":false,"EnabledFolders":["movies"]}}]`)
			}
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	return server, mode
}

func createManagedServer(t *testing.T, a *App, token, provider, url string) int64 {
	t.Helper()
	w := apiRequest(a, "POST", "/api/servers", token, map[string]any{"server_nickname": "Fixture " + provider, "service_type": provider, "url": url, "api_key": "fixture-secret"}, nil)
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	if strings.Contains(w.Body.String(), "fixture-secret") || strings.Contains(w.Body.String(), `"api_key"`) {
		t.Fatal("server response leaked credentials")
	}
	return int64(responseData(t, w)["id"].(float64))
}

func TestCompiledProviderAdaptersAndSyncIdentityPreservation(t *testing.T) {
	for _, kind := range []string{"jellyfin", "emby", "kavita"} {
		t.Run(kind, func(t *testing.T) {
			upstream, mode := providerFixture(t, kind)
			a, s := testApp(t)
			token, _ := bootstrapOwner(t, a)
			owner, err := s.Authenticate(t.Context(), token)
			if err != nil {
				t.Fatal(err)
			}
			id := createManagedServer(t, a, token, kind, upstream.URL)
			w := apiRequest(a, "POST", fmt.Sprintf("/api/servers/%d/test-connection", id), token, nil, nil)
			if w.Code != 200 {
				t.Fatal(w.Code, w.Body.String())
			}
			path := fmt.Sprintf("/api/servers/%d/sync", id)
			w = apiRequest(a, "POST", path, token, nil, nil)
			if w.Code != 200 {
				t.Fatal(w.Code, w.Body.String())
			}
			counts := responseData(t, w)
			if counts["added"] != float64(1) || counts["removed"] != float64(0) {
				t.Fatal(counts)
			}
			var serviceUUID string
			var publicID int64
			if err := s.reader.QueryRow("SELECT a.uuid,i.id FROM service_accounts a JOIN identities i ON i.uuid=a.uuid WHERE a.server_id=?", id).Scan(&serviceUUID, &publicID); err != nil {
				t.Fatal(err)
			}
			if err := s.LinkServiceAccounts(t.Context(), owner.UUID, owner.UUID, []string{serviceUUID}); err != nil {
				t.Fatal(err)
			}
			w = apiRequest(a, "POST", path, token, nil, nil)
			if w.Code != 200 {
				t.Fatal(w.Code, w.Body.String())
			}
			counts = responseData(t, w)
			if counts["added"] != float64(0) || counts["updated"] != float64(1) || counts["removed"] != float64(0) {
				t.Fatal(counts)
			}
			var uuid string
			var repeatID int64
			var links int
			if err := s.reader.QueryRow("SELECT a.uuid,i.id,(SELECT count(*) FROM service_links WHERE service_uuid=a.uuid) FROM service_accounts a JOIN identities i ON i.uuid=a.uuid WHERE a.server_id=?", id).Scan(&uuid, &repeatID, &links); err != nil || uuid != serviceUUID || repeatID != publicID || links != 1 {
				t.Fatal("sync changed identity/links", err, uuid, repeatID, links)
			}
			mode.Store(1)
			w = apiRequest(a, "POST", path, token, nil, nil)
			if w.Code != 502 || strings.Contains(w.Body.String(), "fixture-secret") {
				t.Fatal(w.Code, w.Body.String())
			}
			var active bool
			if err := s.reader.QueryRow("SELECT is_active FROM service_accounts WHERE uuid=?", serviceUUID).Scan(&active); err != nil || !active {
				t.Fatal("failed fetch destroyed snapshot", err)
			}
			mode.Store(2)
			w = apiRequest(a, "POST", path, token, nil, nil)
			if w.Code != 200 || responseData(t, w)["removed"] != float64(1) {
				t.Fatal(w.Code, w.Body.String())
			}
			if err := s.reader.QueryRow("SELECT is_active FROM service_accounts WHERE uuid=?", serviceUUID).Scan(&active); err != nil || active {
				t.Fatal("missing account not deactivated", err)
			}
			if w := apiRequest(a, "GET", "/api/users?user_type=service&page_size=1", token, nil, nil); w.Code != 200 || strings.Contains(w.Body.String(), "fixture-secret") {
				t.Fatal(w.Code, w.Body.String())
			}
			if w := apiRequest(a, "GET", "/api/libraries", token, nil, nil); w.Code != 200 {
				t.Fatal(w.Code, w.Body.String())
			}
			if err := s.CheckIntegrity(t.Context()); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestProviderPermissionsValidationAndRevisionGuards(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	owner, err := s.Authenticate(t.Context(), token)
	if err != nil {
		t.Fatal(err)
	}
	member, err := s.CreateAccount(t.Context(), owner.UUID, "member", "encoded", false)
	if err != nil {
		t.Fatal(err)
	}
	tokens, err := s.issueSession(t.Context(), member, false)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/api/providers", "/api/servers", "/api/libraries", "/api/users", "/api/sync/status"} {
		if w := apiRequest(a, "GET", path, tokens.Access, nil, nil); w.Code != 403 {
			t.Fatal(path, w.Code)
		}
	}
	upstream, _ := providerFixture(t, "jellyfin")
	id := createManagedServer(t, a, token, "jellyfin", upstream.URL)
	for _, input := range []map[string]any{
		{"server_nickname": "bad", "service_type": "unimplemented", "url": upstream.URL, "api_key": "secret"},
		{"server_nickname": "bad", "service_type": "jellyfin", "url": "file:///tmp/private", "api_key": "secret"},
		{"server_nickname": "bad", "service_type": "jellyfin", "url": "http://name:pass@example.invalid", "api_key": "secret"},
	} {
		if w := apiRequest(a, "POST", "/api/servers", token, input, nil); w.Code != 400 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	path := fmt.Sprintf("/api/servers/%d", id)
	w := apiRequest(a, "PATCH", path, token, map[string]any{"server_nickname": "Updated", "revision": 0}, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := apiRequest(a, "PATCH", path, token, map[string]any{"server_nickname": "Stale", "revision": 0}, nil); w.Code != 409 {
		t.Fatal(w.Code)
	}
	snapshot, err := a.loadServer(t.Context(), id)
	if err != nil {
		t.Fatal(err)
	}
	if w := apiRequest(a, "POST", "/api/providers/jellyfin/disable", token, nil, nil); w.Code != 200 {
		t.Fatal(w.Code)
	}
	if _, err := a.syncServer(t.Context(), owner.UUID, token, snapshot, true, true); err != ErrConflict {
		t.Fatal("disabled provider committed stale snapshot", err)
	}
	if w := apiRequest(a, "POST", path+"/sync", token, nil, nil); w.Code != 409 {
		t.Fatal(w.Code)
	}
	if w := apiRequest(a, "GET", "/api/users?sort=id%3BDROP%20TABLE%20users", token, nil, nil); w.Code != 400 {
		t.Fatal(w.Code)
	}
	if w := apiRequest(a, "DELETE", path, token, nil, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
}

func TestProviderRedirectCancellationAndInvalidSnapshot(t *testing.T) {
	var stolen atomic.Int32
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { stolen.Add(1); w.WriteHeader(200) }))
	defer destination.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, destination.URL, 302) }))
	defer redirect.Close()
	p, err := newServerConnection(ProviderConfig{"jellyfin", redirect.URL, "fixture-secret"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.Test(t.Context()); err == nil || stolen.Load() != 0 {
		t.Fatal("credentials followed redirect", err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := p.Users(ctx); err == nil {
		t.Fatal("cancellation ignored")
	}
	upstream, mode := providerFixture(t, "jellyfin")
	mode.Store(3)
	p, err = newServerConnection(ProviderConfig{"jellyfin", upstream.URL, "fixture-secret"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.Libraries(t.Context()); err == nil {
		t.Fatal("duplicate IDs accepted")
	}
}

func TestConfigurationChangeDuringProviderFetchCannotCommit(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	owner, err := s.Authenticate(t.Context(), token)
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/Users") {
			close(started)
			select {
			case <-release:
			case <-r.Context().Done():
				return
			}
			fmt.Fprint(w, `[{"Id":"user","Name":"User","Policy":{"IsDisabled":false,"EnableAllFolders":false,"EnabledFolders":[]}}]`)
		} else {
			fmt.Fprint(w, `[{"ItemId":"library","Name":"Library"}]`)
		}
	}))
	defer func() { once.Do(func() { close(release) }); upstream.Close() }()
	id := createManagedServer(t, a, token, "jellyfin", upstream.URL)
	snapshot, err := a.loadServer(t.Context(), id)
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { _, err := a.syncServer(t.Context(), owner.UUID, token, snapshot, true, true); done <- err }()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("provider request never started")
	}
	if w := apiRequest(a, "PATCH", fmt.Sprintf("/api/servers/%d", id), token, map[string]any{"is_active": false}, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	once.Do(func() { close(release) })
	if err := <-done; err != ErrConflict {
		t.Fatal("stale snapshot committed", err)
	}
	for _, table := range []string{"media_libraries", "service_accounts"} {
		var count int
		if err := s.reader.QueryRow("SELECT count(*) FROM " + table).Scan(&count); err != nil || count != 0 {
			t.Fatal(table, count, err)
		}
	}
}

func TestSyncAllReportsPerServerFailureAndActualCounts(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	one, _ := providerFixture(t, "jellyfin")
	two, mode := providerFixture(t, "emby")
	mode.Store(1)
	createManagedServer(t, a, token, "jellyfin", one.URL)
	createManagedServer(t, a, token, "emby", two.URL)
	w := apiRequest(a, "POST", "/api/users/sync-all", token, nil, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	data := responseData(t, w)
	summary := data["summary"].(map[string]any)
	if summary["successful"] != float64(1) || summary["failed"] != float64(1) || summary["total_added"] != float64(1) {
		t.Fatal(data)
	}
	var users, libraries int
	if err := s.reader.QueryRow("SELECT count(*) FROM service_accounts").Scan(&users); err != nil {
		t.Fatal(err)
	}
	if err := s.reader.QueryRow("SELECT count(*) FROM media_libraries").Scan(&libraries); err != nil {
		t.Fatal(err)
	}
	if users != 1 || libraries != 1 {
		t.Fatal("partial failed-server snapshot persisted", users, libraries)
	}
	w = apiRequest(a, "GET", "/api/sync/status", token, nil, nil)
	if w.Code != 200 || responseData(t, w)["is_syncing"] != false {
		t.Fatal(w.Code, w.Body.String())
	}
}

func TestSavedServerTracksRealStatusAndRejectsDeletingSyncedResources(t *testing.T) {
	a, _ := testApp(t)
	token, _ := bootstrapOwner(t, a)
	upstream, mode := providerFixture(t, "jellyfin")
	id := createManagedServer(t, a, token, "jellyfin", upstream.URL)
	path := fmt.Sprintf("/api/servers/%d", id)
	if w := apiRequest(a, "POST", path+"/test-connection", token, nil, nil); w.Code != 200 {
		t.Fatal(w.Code)
	}
	if w := apiRequest(a, "GET", path, token, nil, nil); w.Code != 200 || responseData(t, w)["last_status"] != true {
		t.Fatal(w.Code, w.Body.String())
	}
	mode.Store(4)
	if w := apiRequest(a, "POST", path+"/test-connection", token, nil, nil); w.Code != 502 {
		t.Fatal(w.Code)
	}
	if w := apiRequest(a, "GET", path, token, nil, nil); w.Code != 200 || responseData(t, w)["last_status"] != false {
		t.Fatal(w.Code, w.Body.String())
	}
	mode.Store(0)
	if w := apiRequest(a, "POST", path+"/sync", token, nil, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := apiRequest(a, "DELETE", path, token, nil, nil); w.Code != 409 {
		t.Fatal("deleted referenced server", w.Code)
	}
}
