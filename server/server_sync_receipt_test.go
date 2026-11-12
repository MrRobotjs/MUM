package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestServerSyncScopedCommittedReceiptsAndFailure(t *testing.T) {
	a, store := testApp(t)
	token, _ := bootstrapOwner(t, a)
	remote, mode := providerFixture(t, "jellyfin")
	id := createManagedServer(t, a, token, "jellyfin", remote.URL)
	for _, scope := range []string{"libraries", "users"} {
		s, err := a.loadServer(t.Context(), id)
		if err != nil {
			t.Fatal(err)
		}
		w := apiRequest(a, "POST", fmt.Sprintf("/api/servers/%d/sync-%s", id, scope), token, map[string]any{"expected_server_revision": s.Revision}, nil)
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
		d := responseData(t, w)
		saved, err := a.loadServer(t.Context(), id)
		if err != nil || d["server_id"] != float64(id) || d["scope"] != scope || d["source_revision"] != float64(s.Revision) || d["revision"] != float64(saved.Revision) || saved.Revision != s.Revision+1 {
			t.Fatal(d, saved, err)
		}
		if scope == "libraries" && d["users"] != float64(0) || scope == "users" && d["libraries"] != float64(0) {
			t.Fatal(d)
		}
	}
	s, err := a.loadServer(t.Context(), id)
	if err != nil {
		t.Fatal(err)
	}
	mode.Store(1)
	w := apiRequest(a, "POST", fmt.Sprintf("/api/servers/%d/sync-users", id), token, map[string]any{"expected_server_revision": s.Revision}, nil)
	if w.Code != 502 {
		t.Fatal(w.Code, w.Body.String())
	}
	saved, err := a.loadServer(t.Context(), id)
	if err != nil || saved.Revision != s.Revision {
		t.Fatal(saved, err)
	}
	var active int
	if err := store.reader.QueryRow("SELECT count(*) FROM service_accounts WHERE server_id=? AND is_active=1", id).Scan(&active); err != nil || active != 1 {
		t.Fatal(active, err)
	}
}

func TestServerSyncStaleIntentNeverContactsProvider(t *testing.T) {
	a, _ := testApp(t)
	token, _ := bootstrapOwner(t, a)
	var calls atomic.Int32
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); fmt.Fprint(w, `[]`) }))
	defer remote.Close()
	id := createManagedServer(t, a, token, "jellyfin", remote.URL)
	s, err := a.loadServer(t.Context(), id)
	if err != nil {
		t.Fatal(err)
	}
	for _, body := range []map[string]any{{"expected_server_revision": s.Revision + 1}, {"expected_server_revision": nil}, {"expected_server_revision": s.Revision, "other": true}} {
		w := apiRequest(a, "POST", fmt.Sprintf("/api/servers/%d/sync-users", id), token, body, nil)
		if w.Code != 400 && w.Code != 409 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	if calls.Load() != 0 {
		t.Fatal("stale intent contacted provider", calls.Load())
	}
}

func TestServerSyncSessionLostDuringReadCannotCommit(t *testing.T) {
	a, store := testApp(t)
	token, _ := bootstrapOwner(t, a)
	owner, err := store.Authenticate(t.Context(), token)
	if err != nil {
		t.Fatal(err)
	}
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := store.writer.ExecContext(r.Context(), "DELETE FROM app_sessions WHERE user_uuid=?", owner.UUID); err != nil {
			t.Error(err)
		}
		fmt.Fprint(w, `[{"Id":"new","Name":"New","Policy":{"IsDisabled":false,"EnableAllFolders":true}}]`)
	}))
	defer remote.Close()
	id := createManagedServer(t, a, token, "jellyfin", remote.URL)
	w := apiRequest(a, "POST", fmt.Sprintf("/api/servers/%d/sync-users", id), token, nil, nil)
	if w.Code != 403 {
		t.Fatal(w.Code, w.Body.String())
	}
	var n int
	if err := store.reader.QueryRow("SELECT count(*) FROM service_accounts WHERE server_id=?", id).Scan(&n); err != nil || n != 0 {
		t.Fatal(n, err)
	}
}
