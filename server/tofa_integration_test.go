package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestTofaUserSyncAndScheduledRefresh(t *testing.T) {
	var mode atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer fixture-secret" {
			w.WriteHeader(401)
			return
		}
		switch r.URL.Path {
		case "/api/v1/system/info":
			fmt.Fprint(w, `{"version":"0.14.0"}`)
		case "/api/v1/users":
			if mode.Load() == 1 {
				fmt.Fprint(w, `null`)
				return
			}
			fmt.Fprintf(w, `[{"id":"01234567-89ab-4cde-8fab-0123456789ab","username":"Reader","disabled":%t,"preferences":{},"created_at":"2026-01-01T00:00:00Z"}]`, mode.Load() == 2)
		default:
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	id := createManagedServer(t, a, token, "tofa", upstream.URL)
	path := fmt.Sprintf("/api/servers/%d", id)
	if w := apiRequest(a, "POST", path+"/test-connection", token, nil, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := apiRequest(a, "POST", path+"/sync", token, nil, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var uuid, name, joined, policy string
	var active bool
	read := func() {
		t.Helper()
		if err := s.reader.QueryRow(`SELECT uuid,external_username,is_active,coalesce(service_join_date,''),service_settings FROM service_accounts WHERE server_id=?`, id).Scan(&uuid, &name, &active, &joined, &policy); err != nil {
			t.Fatal(err)
		}
	}
	read()
	original := uuid
	if !active || name != "Reader" || joined == "" || !strings.Contains(policy, `"library_policy_known":false`) {
		t.Fatal(name, active, joined, policy)
	}
	if w := apiRequest(a, "POST", "/api/users/sync-all", token, nil, nil); w.Code != 200 || responseData(t, w)["summary"].(map[string]any)["failed"] != float64(0) {
		t.Fatal("global user sync", w.Code, w.Body.String())
	}
	mode.Store(1)
	if w := apiRequest(a, "POST", path+"/sync-users", token, nil, nil); w.Code != 502 {
		t.Fatal(w.Code, w.Body.String())
	}
	read()
	if !active || uuid != original {
		t.Fatal("invalid snapshot changed account")
	}
	mode.Store(2)
	activityExec(t, s, "DELETE FROM app_sessions")
	activityExec(t, s, `UPDATE server_refresh_schedules SET next_run_at='2000-01-01T00:00:00Z' WHERE server_id=?`, id)
	if err := a.runOneServerRefreshScope(t.Context(), "libraries"); err != nil {
		t.Fatal(err)
	}
	if err := a.runOneServerRefreshScope(t.Context(), "users"); err != nil {
		t.Fatal(err)
	}
	read()
	if active || uuid != original {
		t.Fatal("scheduled sync did not preserve account identity and disabled state")
	}
	var state string
	if err := s.reader.QueryRow(`SELECT run_state FROM server_refresh_schedules WHERE server_id=? AND scope='libraries'`, id).Scan(&state); err != nil || state == "failed" || state == "running" {
		t.Fatal(state, err)
	}
}
