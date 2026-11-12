package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

type downloadPolicyFixture struct {
	server *httptest.Server
	mode   atomic.Int32
	writes atomic.Int32
}

func newDownloadPolicyFixture(t *testing.T, provider string) *downloadPolicyFixture {
	t.Helper()
	f := &downloadPolicyFixture{}
	prefix := ""
	if provider == "emby" {
		prefix = "/emby"
	}
	if provider == "kavita" || provider == "audiobookshelf" {
		prefix = "/api"
	}
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" {
			f.writes.Add(1)
			http.Error(w, "unexpected write", 500)
			return
		}
		key := r.Header.Get("X-Emby-Token")
		if provider == "kavita" || provider == "komga" {
			key = r.Header.Get("x-api-key")
		}
		if provider == "audiobookshelf" {
			key = strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		}
		if key != "fixture-secret" {
			http.Error(w, "unauthorized", 401)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch strings.TrimPrefix(r.URL.Path, prefix) {
		case "/System/Info", "/health":
			fmt.Fprint(w, `{"ServerName":"Fixture","Version":"1"}`)
		case "/Library/VirtualFolders":
			fmt.Fprint(w, `[{"ItemId":"movies","Name":"Movies"}]`)
		case "/libraries":
			fmt.Fprint(w, `{"libraries":[{"id":"movies","name":"Movies","mediaType":"book"}]}`)
		case "/Library/libraries":
			fmt.Fprint(w, `[{"id":2,"name":"Books","type":2}]`)
		case "/api/v1/libraries":
			fmt.Fprint(w, `[{"id":"movies","name":"Movies"}]`)
		case "/Users", "/users", "/api/v2/users":
			mode := f.mode.Load()
			if mode == 5 {
				http.Error(w, "private failure", 503)
				return
			}
			if mode == 6 {
				if provider == "audiobookshelf" {
					fmt.Fprint(w, `{"users":[]}`)
				} else {
					fmt.Fprint(w, `[]`)
				}
				return
			}
			policy := map[string]any{"IsDisabled": mode == 7, "EnableAllFolders": true, "EnableSyncTranscoding": mode == 1}
			switch mode {
			case 0, 7:
				policy["EnableContentDownloading"] = true
			case 1:
				policy["EnableContentDownloading"] = false
			case 3:
				policy["EnableContentDownloading"] = nil
			case 4:
				policy["EnableContentDownloading"] = "true"
			case 8:
				policy["EnableContentDownloading"] = 1
			}
			rows := []map[string]any{{"Id": "same-external", "Name": "Reader", "Policy": policy, "Password": "never-persist"}}
			if mode == 9 {
				rows = append(rows, map[string]any{"Id": "partial", "Name": "Partial", "Policy": nil})
			}
			if provider == "komga" {
				roles := any([]string{"USER", "FILE_DOWNLOAD"})
				switch mode {
				case 1:
					roles = []string{"USER", "PAGE_STREAMING"}
				case 3:
					roles = nil
				case 4:
					roles = "FILE_DOWNLOAD"
				case 8:
					roles = 1
				case 10:
					roles = []string{"ADMIN"}
				case 11:
					roles = []string{}
				case 12:
					roles = []any{nil}
				case 13:
					roles = []string{"USER", "PAGE_STREAMING", "KOBO_SYNC", "KOREADER_SYNC"}
				case 14:
					roles = []string{"file_download"}
				}
				row := map[string]any{"id": "same-external", "email": "reader@example.invalid", "roles": roles, "sharedAllLibraries": mode != 7, "sharedLibrariesIds": []string{}}
				if mode == 2 {
					delete(row, "roles")
				}
				output := []map[string]any{row}
				if mode == 9 {
					output = append(output, map[string]any{"id": "partial", "email": "partial@example.invalid"})
				}
				json.NewEncoder(w).Encode(output)
			} else if provider == "kavita" {
				roles := any([]string{"Pleb", "Login", "Download"})
				switch mode {
				case 1, 11:
					roles = []string{}
				case 3:
					roles = nil
				case 4:
					roles = "Download"
				case 8:
					roles = 1
				case 10:
					roles = []string{"Admin"}
				case 12:
					roles = []any{nil}
				}
				row := map[string]any{"id": 7, "username": "Reader", "isPending": mode == 7, "roles": roles, "libraries": []any{map[string]any{"id": 2}}}
				if mode == 2 {
					delete(row, "roles")
				}
				output := []map[string]any{row}
				if mode == 9 {
					output = append(output, map[string]any{"id": 8, "username": "Partial"})
				}
				json.NewEncoder(w).Encode(output)
			} else if provider == "audiobookshelf" {
				permissions := map[string]any{"accessAllLibraries": true}
				if value, ok := policy["EnableContentDownloading"]; ok {
					permissions["download"] = value
				}
				row := map[string]any{"id": "same-external", "username": "Reader", "isActive": mode != 7, "permissions": permissions}
				output := []map[string]any{row}
				if mode == 9 {
					output = append(output, map[string]any{"id": "partial", "username": "Partial"})
				}
				json.NewEncoder(w).Encode(map[string]any{"users": output})
			} else {
				json.NewEncoder(w).Encode(rows)
			}
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(f.server.Close)
	return f
}

func TestProviderDownloadPolicyKnownUnknownAndMalformed(t *testing.T) {
	for _, provider := range []string{"jellyfin", "emby", "kavita", "audiobookshelf", "komga"} {
		t.Run(provider, func(t *testing.T) {
			f := newDownloadPolicyFixture(t, provider)
			p, err := newServerConnection(ProviderConfig{provider, f.server.URL, "fixture-secret"}, f.server.Client())
			if err != nil {
				t.Fatal(err)
			}
			for _, tc := range []struct {
				name                    string
				mode                    int32
				known, allowed, invalid bool
			}{
				{"allow", 0, true, true, false}, {"deny despite sync flag", 1, true, false, false},
				{"missing", 2, false, false, false}, {"null", 3, false, false, false},
				{"string", 4, false, false, true}, {"number", 8, false, false, true}, {"partial snapshot", 9, false, false, true},
			} {
				t.Run(tc.name, func(t *testing.T) {
					f.mode.Store(tc.mode)
					rows, err := p.Users(t.Context())
					if tc.invalid || (provider == "kavita" || provider == "komga") && (tc.mode == 2 || tc.mode == 3) {
						if err == nil {
							t.Fatal("accepted malformed snapshot")
						}
						return
					}
					if err != nil || len(rows) != 1 {
						t.Fatal(rows, err)
					}
					access := rows[0].Access
					if access == nil || !access.LibrariesKnown || access.DownloadsKnown != tc.known || access.AllowDownloads != tc.allowed {
						t.Fatal(access)
					}
				})
			}
		})
	}
}

func TestProviderDownloadLabelsLifecycleAndRetainedUnknown(t *testing.T) {
	for _, provider := range []string{"jellyfin", "emby", "kavita", "audiobookshelf", "komga"} {
		t.Run(provider, func(t *testing.T) {
			f := newDownloadPolicyFixture(t, provider)
			a, s := testApp(t)
			a.ProviderHTTP = f.server.Client()
			token, _ := bootstrapOwner(t, a)
			id := createManagedServer(t, a, token, provider, f.server.URL)
			syncRomMLabel(t, a, token, id, 200)
			service, role, allowed, source := rommLabelSource(t, s, id)
			if !allowed {
				t.Fatal("missing allow")
			}
			var settings string
			if err := s.reader.QueryRow("SELECT service_settings FROM service_accounts WHERE uuid=?", service).Scan(&settings); err != nil || strings.Contains(settings, "content_restrictions_present") {
				t.Fatal("unobserved content restrictions became a known false", settings, err)
			}
			var observedProvider string
			if err := s.reader.QueryRow("SELECT provider_type FROM download_observations WHERE service_uuid=?", service).Scan(&observedProvider); err != nil || observedProvider != provider {
				t.Fatal(observedProvider, err)
			}
			if _, err := s.writer.Exec("INSERT INTO user_roles(id,name) VALUES('manual','Friend'); INSERT INTO identity_user_roles(user_uuid,role_id) SELECT uuid,'manual' FROM service_accounts WHERE server_id=?", id); err != nil {
				t.Fatal(err)
			}
			for _, mode := range []int32{2, 3} {
				if provider == "kavita" || provider == "komga" {
					continue
				}
				f.mode.Store(mode)
				syncRomMLabel(t, a, token, id, 200)
				_, _, kept, revision := rommLabelSource(t, s, id)
				if !kept || revision != source {
					t.Fatal("unknown overwrote observation")
				}
			}
			failedModes := []int32{4, 5, 8, 9}
			if provider == "kavita" || provider == "komga" {
				failedModes = append(failedModes, 2, 3, 12)
			}
			for _, mode := range failedModes {
				before := rommLabelState(t, s, id)
				f.mode.Store(mode)
				w := apiRequest(a, "POST", fmt.Sprintf("/api/servers/%d/sync", id), token, nil, nil)
				if w.Code < 400 || rommLabelState(t, s, id) != before {
					t.Fatal("failed snapshot committed", w.Code, w.Body.String())
				}
			}
			f.mode.Store(6)
			syncRomMLabel(t, a, token, id, 200)
			_, _, kept, revision := rommLabelSource(t, s, id)
			if !kept || revision != source {
				t.Fatal("absent user erased source")
			}
			f.mode.Store(7)
			syncRomMLabel(t, a, token, id, 200)
			_, _, kept, _ = rommLabelSource(t, s, id)
			if !kept {
				t.Fatal("inactive flag inferred denial")
			}
			f.mode.Store(1)
			syncRomMLabel(t, a, token, id, 200)
			_, _, kept, _ = rommLabelSource(t, s, id)
			if kept {
				t.Fatal("denial ignored")
			}
			var member, manual bool
			if err := s.reader.QueryRow("SELECT EXISTS(SELECT 1 FROM identity_user_roles WHERE user_uuid=? AND role_id=?),EXISTS(SELECT 1 FROM identity_user_roles WHERE user_uuid=? AND role_id='manual')", service, role, service).Scan(&member, &manual); err != nil || member || !manual {
				t.Fatal(member, manual, err)
			}
			f.mode.Store(0)
			syncRomMLabel(t, a, token, id, 200)
			syncRomMLabel(t, a, token, id, 200)
			if f.writes.Load() != 0 {
				t.Fatal("provider writes")
			}
		})
	}
}

func TestProviderDownloadLabelsShareRegistryWithoutSharingIdentity(t *testing.T) {
	a, s, token, romm, f := rommLabelFixture(t)
	syncRomMLabel(t, a, token, romm, 200)
	_, role, _, _ := rommLabelSource(t, s, romm)
	for _, provider := range []string{"jellyfin", "emby", "kavita", "audiobookshelf", "komga"} {
		fixture := newDownloadPolicyFixture(t, provider)
		a.ProviderHTTP = fixture.server.Client()
		id := createManagedServer(t, a, token, provider, fixture.server.URL)
		syncRomMLabel(t, a, token, id, 200)
		_, same, allow, _ := rommLabelSource(t, s, id)
		if same != role || !allow {
			t.Fatal("registry not shared")
		}
		fixture.mode.Store(1)
		syncRomMLabel(t, a, token, id, 200)
	}
	a.ProviderHTTP = f.server.Client()
	syncRomMLabel(t, a, token, romm, 200)
	var count int
	if err := s.reader.QueryRow("SELECT count(*) FROM identity_user_roles WHERE role_id=?", role).Scan(&count); err != nil || count != 1 {
		t.Fatal(count, err)
	}
	if _, err := s.writer.Exec("UPDATE download_observations SET provider_type='emby' WHERE server_id=?", romm); err != nil {
		t.Fatal(err)
	}
	before := rommLabelState(t, s, romm)
	syncRomMLabel(t, a, token, romm, 409)
	if rommLabelState(t, s, romm) != before {
		t.Fatal("provider provenance drift committed")
	}
}

func TestKavitaDownloadRolesUseExactCompleteFacts(t *testing.T) {
	f := newDownloadPolicyFixture(t, "kavita")
	p, err := newServerConnection(ProviderConfig{"kavita", f.server.URL, "fixture-secret"}, f.server.Client())
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		mode    int32
		allowed bool
	}{{10, true}, {11, false}} {
		f.mode.Store(tc.mode)
		rows, err := p.Users(t.Context())
		if err != nil || len(rows) != 1 || rows[0].Access == nil || !rows[0].Access.DownloadsKnown || rows[0].Access.AllowDownloads != tc.allowed {
			t.Fatal(rows, err)
		}
	}
	f.mode.Store(12)
	if _, err := p.Users(t.Context()); err == nil {
		t.Fatal("null role became denial")
	}
}

func TestKomgaDownloadRoleRequiresExactFileDownloadFact(t *testing.T) {
	f := newDownloadPolicyFixture(t, "komga")
	p, err := newServerConnection(ProviderConfig{"komga", f.server.URL, "fixture-secret"}, f.server.Client())
	if err != nil {
		t.Fatal(err)
	}
	for _, mode := range []int32{10, 11, 13, 14} {
		f.mode.Store(mode)
		rows, err := p.Users(t.Context())
		if err != nil || len(rows) != 1 || rows[0].Access == nil || !rows[0].Access.DownloadsKnown || rows[0].Access.AllowDownloads {
			t.Fatal(mode, rows, err)
		}
	}
	f.mode.Store(12)
	if _, err := p.Users(t.Context()); err == nil {
		t.Fatal("null role inferred denial")
	}
	f.mode.Store(7)
	rows, err := p.Users(t.Context())
	if err != nil || len(rows) != 1 || rows[0].Active || !rows[0].Access.AllowDownloads {
		t.Fatal("library absence erased role fact", rows, err)
	}
}
