package main

import (
	"encoding/json"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestRuntimeInfoObservedFactsAndOwnerPaths(t *testing.T) {
	f := activityReadFixture(t)
	w := apiRequest(f.app, "GET", "/api/settings/runtime-info", f.ownerToken, nil, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var result struct {
		Data runtimeInformation `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	d := result.Data
	if d.GoVersion != runtime.Version() || d.Platform != runtime.GOOS+"/"+runtime.GOARCH || d.Database != "SQLite" || d.DatabaseVersion == "" || d.Timezone == "" || d.DatabaseFile == nil || d.DataDirectory == nil || filepath.Dir(*d.DatabaseFile) != f.store.dataDir || *d.DataDirectory != f.store.dataDir {
		t.Fatalf("invalid runtime information: %+v", d)
	}
	for _, absent := range []string{"python_version", "git_branch", "invitation.key", "plex.key", "password", "api_key"} {
		if strings.Contains(w.Body.String(), absent) {
			t.Fatal("unexpected runtime field", absent)
		}
	}
}

func TestRuntimeInfoAdministratorPathsAndRevocation(t *testing.T) {
	f := activityReadFixture(t)
	w := apiRequest(f.app, "GET", "/api/settings/runtime-info", f.token, nil, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var result struct {
		Data runtimeInformation `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Data.Actor != f.user || result.Data.DatabaseFile != nil || result.Data.DataDirectory != nil || strings.Contains(w.Body.String(), f.store.dataDir) {
		t.Fatal(w.Body.String())
	}
	activityExec(t, f.store, "DELETE FROM admin_privileges WHERE user_uuid=?", f.user)
	if w = apiRequest(f.app, "GET", "/api/settings/runtime-info", f.token, nil, nil); w.Code != 403 {
		t.Fatal("revoked administrator", w.Code)
	}
}

func TestRuntimeInfoRejectsAnonymousQueriesAndLegacyEndpoint(t *testing.T) {
	f := activityReadFixture(t)
	for _, c := range []struct {
		path, token string
		status      int
	}{
		{"/api/settings/runtime-info", "", 401},
		{"/api/settings/runtime-info?path=secret", f.ownerToken, 400},
		{"/api/settings/system-config", f.ownerToken, 404},
	} {
		if w := apiRequest(f.app, "GET", c.path, c.token, nil, nil); w.Code != c.status {
			t.Fatal(c.path, w.Code, w.Body.String())
		}
	}
}
