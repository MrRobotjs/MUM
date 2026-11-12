package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

type rommPermissionFixture struct {
	server       *httptest.Server
	mode         atomic.Int32
	mu           sync.Mutex
	variant      string
	beforePolicy func()
}

func newRomMPermissionFixture(t *testing.T, variant string) *rommPermissionFixture {
	t.Helper()
	f := &rommPermissionFixture{variant: variant}
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		v, hook := f.variant, f.beforePolicy
		f.mu.Unlock()
		if r.Method != "GET" || r.Header.Get("Authorization") != "Bearer fixture-secret" || r.URL.RawQuery != "" {
			t.Error("unexpected method/authentication/query")
			http.Error(w, "invalid", 400)
			return
		}
		catalog := map[string]any{"entities": []string{"platforms", "roms", "collections", "playlists", "firmware", "assets", "devices", "users", "tasks", "logs", "streaming", "emulation"}, "actions": []string{"read", "write", "delete"}, "ownable_entities": []string{"collections", "playlists", "assets", "devices", "streaming", "emulation"}}
		user := map[string]any{"id": 2, "username": "Reader", "email": "reader@example.invalid", "enabled": true, "role": "user", "permission_group_id": nil, "hashed_password": "never-persist"}
		grant := map[string]any{"entity": "roms", "action": "read", "own_only": false}
		group := map[string]any{"id": 1, "is_default": true, "grants": []any{grant}, "hidden": []any{}, "age_limit": nil, "hide_unrated_roms": false}
		policy := map[string]any{"user_id": 2, "permission_group_id": nil, "overrides": []any{}, "hidden": []any{}, "age_limit": nil, "hide_unrated_roms": nil}
		platforms := []any{map[string]any{"id": 7, "name": "NES", "rom_count": 12}}
		switch v {
		case "deny":
			policy["overrides"] = []any{map[string]any{"entity": "roms", "action": "read", "granted": false, "own_only": false}}
		case "grant":
			group["grants"] = []any{}
			policy["overrides"] = []any{map[string]any{"entity": "roms", "action": "read", "granted": true, "own_only": false}}
		case "explicit-group":
			user["permission_group_id"] = 2
			policy["permission_group_id"] = 2
		case "hidden", "hidden-union":
			platforms = append(platforms, map[string]any{"id": 8, "name": "SNES"})
			group["hidden"] = []any{map[string]any{"entity": "platforms", "entity_id": 8}}
			if v == "hidden-union" {
				policy["hidden"] = []any{map[string]any{"entity": "platforms", "entity_id": 7}}
			}
		case "content":
			group["age_limit"] = 12
			group["hide_unrated_roms"] = true
			policy["hidden"] = []any{map[string]any{"entity": "roms", "entity_id": 19}}
		case "content-override":
			group["hide_unrated_roms"] = true
			policy["hide_unrated_roms"] = false
		case "admin":
			user["role"] = "admin"
			group["hidden"] = []any{map[string]any{"entity": "platforms", "entity_id": 7}}
			group["age_limit"] = 12
		case "disabled":
			user["enabled"] = false
		case "role":
			user["role"] = "viewer"
		case "catalog":
			catalog["entities"] = []string{"roms"}
		case "membership":
			policy["permission_group_id"] = 2
		case "identity":
			policy["user_id"] = 3
		case "missing-group":
			user["permission_group_id"] = 3
			policy["permission_group_id"] = 3
		case "missing-user-membership":
			delete(user, "permission_group_id")
		case "missing-policy-membership":
			delete(policy, "permission_group_id")
		case "missing-group-age":
			delete(group, "age_limit")
		case "missing-policy-age":
			delete(policy, "age_limit")
		case "missing-unrated":
			delete(policy, "hide_unrated_roms")
		case "missing-overrides":
			delete(policy, "overrides")
		case "unknown-grant":
			grant["entity"] = "unknown"
		case "own-only":
			grant["own_only"] = true
		case "missing-own-only":
			delete(grant, "own_only")
		case "duplicate-grants":
			group["grants"] = []any{grant, grant}
		case "duplicate-overrides":
			ov := map[string]any{"entity": "roms", "action": "read", "granted": false, "own_only": false}
			policy["overrides"] = []any{ov, ov}
		case "missing-granted":
			policy["overrides"] = []any{map[string]any{"entity": "roms", "action": "read", "own_only": false}}
		case "hidden-entity":
			policy["hidden"] = []any{map[string]any{"entity": "users", "entity_id": 7}}
		case "hidden-id":
			policy["hidden"] = []any{map[string]any{"entity": "platforms", "entity_id": 0}}
		case "duplicate-hidden":
			h := map[string]any{"entity": "platforms", "entity_id": 7}
			policy["hidden"] = []any{h, h}
		case "age":
			policy["age_limit"] = 22
		}
		secondGroup := map[string]any{"id": 2, "is_default": false, "grants": []any{}, "hidden": []any{}, "age_limit": nil, "hide_unrated_roms": false}
		groups := []any{group, secondGroup}
		if v == "duplicate-group" {
			groups = append(groups, group)
		}
		if v == "duplicate-default" {
			secondGroup["is_default"] = true
		}
		var body any
		switch r.URL.Path {
		case "/proxy/api/platforms":
			body = platforms
		case "/proxy/api/users":
			switch f.mode.Load() {
			case 1:
				http.Error(w, "upstream-private-token", 503)
				return
			case 2:
				fmt.Fprint(w, "null")
				return
			case 3:
				delete(user, "enabled")
			}
			body = []any{user}
			if v == "too-many-users" {
				rows := []any{}
				for i := 1; i <= 101; i++ {
					rows = append(rows, map[string]any{"id": i, "username": fmt.Sprint(i), "enabled": true, "role": "user", "permission_group_id": nil})
				}
				body = rows
			}
		case "/proxy/api/permissions/catalog":
			body = catalog
		case "/proxy/api/permissions/groups":
			body = groups
		case "/proxy/api/permissions/users/2":
			if v == "admin" {
				t.Error("admin must bypass per-user policy")
			}
			if hook != nil {
				hook()
			}
			if v == "policy-error" {
				http.Error(w, "upstream-private-token", 403)
				return
			}
			body = policy
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(body)
	}))
	t.Cleanup(f.server.Close)
	return f
}
func (f *rommPermissionFixture) setVariant(v string) { f.mu.Lock(); f.variant = v; f.mu.Unlock() }

func TestRomMEffectivePermissions(t *testing.T) {
	for _, tc := range []struct {
		name                               string
		all, downloads, restricted, active bool
		ids                                string
	}{
		{"", true, true, false, true, "[]"}, {"deny", false, false, false, true, "[]"},
		{"grant", true, true, false, true, "[]"}, {"explicit-group", false, false, false, true, "[]"},
		{"hidden", false, true, true, true, `["7"]`}, {"hidden-union", false, true, true, true, "[]"},
		{"content", true, true, true, true, "[]"}, {"content-override", true, true, false, true, "[]"},
		{"admin", true, true, false, true, "[]"}, {"disabled", true, true, false, false, "[]"},
	} {
		t.Run("policy-"+tc.name, func(t *testing.T) {
			f := newRomMPermissionFixture(t, tc.name)
			p, err := newMediaProvider(ProviderConfig{"romm", f.server.URL + "/proxy", "fixture-secret"}, f.server.Client())
			if err != nil {
				t.Fatal(err)
			}
			users, err := p.Users(t.Context())
			if err != nil || len(users) != 1 {
				t.Fatal(users, err)
			}
			u := users[0]
			ids, _ := json.Marshal(u.LibraryIDs)
			if u.Access == nil || !u.Access.LibrariesKnown || !u.Access.DownloadsKnown || u.AllLibraries != tc.all || u.Access.AllowDownloads != tc.downloads || u.Access.ContentRestricted != tc.restricted || u.Active != tc.active || string(ids) != tc.ids {
				t.Fatalf("unexpected policy %+v access %+v ids %s", u, u.Access, ids)
			}
		})
	}
}

func TestRomMInvalidSnapshotPreservesAccounts(t *testing.T) {
	f := newRomMPermissionFixture(t, "")
	a, s := testApp(t)
	a.ProviderHTTP = f.server.Client()
	token, _ := bootstrapOwner(t, a)
	id := createManagedServer(t, a, token, "romm", f.server.URL+"/proxy")
	path := fmt.Sprintf("/api/servers/%d/sync", id)
	if w := apiRequest(a, "POST", path, token, nil, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	snapshot := func() string {
		var uuid, settings, ids string
		var active, downloads int
		if err := s.reader.QueryRow("SELECT uuid,service_settings,allowed_library_ids,is_active,allow_downloads FROM service_accounts WHERE server_id=?", id).Scan(&uuid, &settings, &ids, &active, &downloads); err != nil {
			t.Fatal(err)
		}
		return fmt.Sprint(uuid, settings, ids, active, downloads)
	}
	before := snapshot()
	for _, v := range []string{"role", "catalog", "membership", "identity", "missing-group", "missing-user-membership", "missing-policy-membership", "missing-group-age", "missing-policy-age", "missing-unrated", "missing-overrides", "unknown-grant", "own-only", "missing-own-only", "duplicate-grants", "duplicate-overrides", "missing-granted", "hidden-entity", "hidden-id", "duplicate-hidden", "age", "duplicate-group", "duplicate-default", "policy-error", "too-many-users"} {
		t.Run(v, func(t *testing.T) {
			f.setVariant(v)
			var audits int
			s.reader.QueryRow("SELECT count(*) FROM audit_events").Scan(&audits)
			w := apiRequest(a, "POST", path, token, nil, nil)
			if w.Code == 200 || strings.Contains(w.Body.String(), "upstream-private-token") {
				t.Fatal(w.Code, w.Body.String())
			}
			if snapshot() != before {
				t.Fatal("failed snapshot changed persisted account")
			}
			var after int
			s.reader.QueryRow("SELECT count(*) FROM audit_events").Scan(&after)
			if after != audits {
				t.Fatal("failed sync emitted committed audit")
			}
		})
	}
	f.setVariant("deny")
	if w := apiRequest(a, "POST", path, token, nil, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var uuid string
	var downloads int
	if err := s.reader.QueryRow("SELECT uuid,allow_downloads FROM service_accounts WHERE server_id=?", id).Scan(&uuid, &downloads); err != nil || downloads != 0 || !strings.HasPrefix(before, uuid) {
		t.Fatal("revoked policy/identity not persisted", err, downloads)
	}
}

func TestRomMPermissionSyncRevisionGuard(t *testing.T) {
	f := newRomMPermissionFixture(t, "")
	a, s := testApp(t)
	a.ProviderHTTP = f.server.Client()
	token, _ := bootstrapOwner(t, a)
	id := createManagedServer(t, a, token, "romm", f.server.URL+"/proxy")
	f.mu.Lock()
	f.beforePolicy = func() {
		if _, err := s.writer.Exec("UPDATE media_servers SET revision=revision+1 WHERE id=?", id); err != nil {
			t.Error(err)
		}
	}
	f.mu.Unlock()
	w := apiRequest(a, "POST", fmt.Sprintf("/api/servers/%d/sync", id), token, nil, nil)
	if w.Code != 409 {
		t.Fatal(w.Code, w.Body.String())
	}
	var count int
	s.reader.QueryRow("SELECT count(*) FROM service_accounts WHERE server_id=?", id).Scan(&count)
	if count != 0 {
		t.Fatal("stale snapshot committed")
	}
}

func TestSyncDistinguishesKnownAndUnknownDownloadPolicy(t *testing.T) {
	for _, kind := range []string{"komga", "audiobookshelf", "plex"} {
		t.Run(kind, func(t *testing.T) {
			f, client, _ := extendedProviderFixture(t, kind)
			a, s := testApp(t)
			a.ProviderHTTP = client
			token, _ := bootstrapOwner(t, a)
			id := createManagedServer(t, a, token, kind, f.URL+"/proxy")
			path := fmt.Sprintf("/api/servers/%d/sync", id)
			if w := apiRequest(a, "POST", path, token, nil, nil); w.Code != 200 {
				t.Fatal(w.Code, w.Body.String())
			}
			if _, err := s.writer.Exec("UPDATE service_accounts SET allow_downloads=1 WHERE server_id=?", id); err != nil {
				t.Fatal(err)
			}
			if w := apiRequest(a, "POST", path, token, nil, nil); w.Code != 200 {
				t.Fatal(w.Code, w.Body.String())
			}
			var count int
			expected := 0
			// Complete PAGE_STREAMING-only roles explicitly deny FILE_DOWNLOAD.
			if kind == "komga" {
				expected = 1
			}
			if err := s.reader.QueryRow("SELECT count(*) FROM service_accounts WHERE server_id=? AND allow_downloads=0", id).Scan(&count); err != nil || count != expected {
				t.Fatal("known download fact or unknown-policy preservation mismatch", err, count, expected)
			}
		})
	}
}
