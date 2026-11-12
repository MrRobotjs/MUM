package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestServerConnectionRevisionAndCommittedReceipt(t *testing.T) {
	a, _ := testApp(t)
	token, _ := bootstrapOwner(t, a)
	var calls atomic.Int32
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		fmt.Fprint(w, `{"ServerName":"Fixture","Version":"1.0"}`)
	}))
	defer remote.Close()
	id := createManagedServer(t, a, token, "jellyfin", remote.URL)
	s, err := a.loadServer(t.Context(), id)
	if err != nil {
		t.Fatal(err)
	}
	path := fmt.Sprintf("/api/servers/%d/test-connection", id)
	for _, body := range []map[string]any{{"expected_server_revision": s.Revision + 1}, {"expected_server_revision": nil}, {"expected_server_revision": s.Revision, "other": true}} {
		w := apiRequest(a, "POST", path, token, body, nil)
		if w.Code != 400 && w.Code != 409 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	if calls.Load() != 0 {
		t.Fatal("stale selection probed provider")
	}
	w := apiRequest(a, "POST", path, token, map[string]any{"expected_server_revision": s.Revision}, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	d := responseData(t, w)
	saved, err := a.loadServer(t.Context(), id)
	if err != nil || d["server_id"] != float64(id) || d["revision"] != float64(s.Revision) || d["checked_at"] != saved.LastStatusCheck || saved.LastStatus == nil || !*saved.LastStatus || calls.Load() != 1 {
		t.Fatal(d, saved, err)
	}
}

func TestServerConnectionSessionRevocationCannotPersistProbe(t *testing.T) {
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
		fmt.Fprint(w, `{"ServerName":"Must not commit","Version":"9"}`)
	}))
	defer remote.Close()
	id := createManagedServer(t, a, token, "jellyfin", remote.URL)
	w := apiRequest(a, "POST", fmt.Sprintf("/api/servers/%d/test-connection", id), token, nil, nil)
	if w.Code != 403 {
		t.Fatal(w.Code, w.Body.String())
	}
	saved, err := a.loadServer(t.Context(), id)
	if err != nil || saved.LastStatusCheck != "" || saved.LastStatus != nil || saved.ServerName == "Must not commit" {
		t.Fatal(saved, err)
	}
}

func TestServerConnectionChangedSourceCannotPersistProbe(t *testing.T) {
	a, store := testApp(t)
	token, _ := bootstrapOwner(t, a)
	var id int64
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := store.writer.ExecContext(r.Context(), "UPDATE media_servers SET revision=revision+1 WHERE id=?", id); err != nil {
			t.Error(err)
		}
		fmt.Fprint(w, `{"ServerName":"Stale","Version":"9"}`)
	}))
	defer remote.Close()
	id = createManagedServer(t, a, token, "jellyfin", remote.URL)
	w := apiRequest(a, "POST", fmt.Sprintf("/api/servers/%d/test-connection", id), token, nil, nil)
	if w.Code != 409 {
		t.Fatal(w.Code, w.Body.String())
	}
	saved, err := a.loadServer(t.Context(), id)
	if err != nil || saved.LastStatusCheck != "" || saved.LastStatus != nil {
		t.Fatal(saved, err)
	}
}
