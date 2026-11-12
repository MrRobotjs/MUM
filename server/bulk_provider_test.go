package main

import (
	"app/server/providers/kavita"
	"app/server/providers/komga"
	"app/server/providers/mediabrowser"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
)

func TestBulkProviderPreservesPolicyAndLostDeleteResponse(t *testing.T) {
	policy := map[string]any{"IsAdministrator": false, "IsDisabled": false, "AuthenticationProviderId": "auth", "PasswordResetProviderId": "reset", "EnableAllFolders": true, "EnabledFolders": []string{}, "EnableContentDownloading": false, "BlockedTags": []string{"adult"}}
	absent := false
	writes := 0
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/System/Info":
			json.NewEncoder(w).Encode(map[string]any{"ServerName": "fixture"})
		case "/Library/VirtualFolders":
			w.Write([]byte(`[{"ItemId":"books","Name":"Books"}]`))
		case "/Users/u":
			if r.Method == "DELETE" {
				absent = true
				writes++
				h := w.(http.Hijacker)
				c, _, _ := h.Hijack()
				c.Close()
				return
			}
			if absent {
				w.WriteHeader(404)
				return
			}
			json.NewEncoder(w).Encode(map[string]any{"Id": "u", "Name": "Reader", "Policy": policy})
		case "/Users/u/Policy":
			writes++
			json.NewDecoder(r.Body).Decode(&policy)
		default:
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
			w.WriteHeader(500)
		}
	}))
	defer s.Close()
	p := &serverConnection{config: ProviderConfig{Type: "jellyfin", URL: s.URL, APIKey: "fixture"}, client: s.Client()}
	req := bulkProviderRequest{Action: "update_libraries", ID: "u", Name: "Reader", LibraryIDs: []string{"books"}}
	snap, err := p.prepareBulkUser(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	res, err := p.executeBulkUser(context.Background(), req, snap, func(string) error { return nil })
	if err != nil || res.Outcome != "updated" {
		t.Fatalf("%+v %v", res, err)
	}
	if policy["EnableContentDownloading"] != false || len(policy["BlockedTags"].([]any)) != 1 {
		t.Fatal("unrelated policy changed")
	}
	req.Action = "delete_users"
	snap, err = p.prepareBulkUser(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	res, err = p.executeBulkUser(context.Background(), req, snap, func(string) error { return nil })
	if err != nil || res.Outcome != "deleted" || writes != 3 {
		t.Fatalf("%+v %v writes=%d", res, err, writes)
	}
}
func TestBulkProviderAuthorityStopsRoundtrip(t *testing.T) {
	calls := 0
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++; w.Write([]byte(`{}`)) }))
	defer s.Close()
	p := &serverConnection{config: ProviderConfig{Type: "jellyfin", URL: s.URL, APIKey: "fixture"}, client: s.Client(), bulkAuthority: func(context.Context) error { return ErrConflict }}
	if _, err := guardedRequest(t, p, "GET", s.URL, nil); err == nil || calls != 0 {
		t.Fatalf("authority bypass %v %d", err, calls)
	}
	checks := 0
	p.bulkAuthority = func(context.Context) error {
		checks++
		if checks > 1 {
			return ErrConflict
		}
		return nil
	}
	if _, err := guardedRequest(t, p, "GET", s.URL, nil); err == nil || calls != 1 {
		t.Fatalf("post authority bypass %v %d", err, calls)
	}
}
func TestBulkProviderGrantMatchingDistinguishesNoneAllAndSubset(t *testing.T) {
	p := &serverConnection{config: ProviderConfig{Type: "jellyfin"}}
	u := remoteReview{Detail: &mediabrowser.Observed{Policy: map[string]any{"EnableAllFolders": false, "EnabledFolders": []string{}}}}
	if !p.bulkGrantMatches(t.Context(), bulkProviderRequest{}, u) || p.bulkGrantMatches(t.Context(), bulkProviderRequest{AllLibraries: true}, u) || p.bulkGrantMatches(t.Context(), bulkProviderRequest{LibraryIDs: []string{"a"}}, u) {
		t.Fatal("zero libraries broadened")
	}
}
func TestBulkProviderSnapshotBindsUnrelatedRestrictions(t *testing.T) {
	p := &serverConnection{config: ProviderConfig{Type: "jellyfin"}}
	a := remoteReview{ID: "id", Name: "reader", Detail: &mediabrowser.Observed{Policy: map[string]any{"EnableAllFolders": false, "EnabledFolders": []string{"a"}, "BlockedTags": []string{"restricted"}}}}
	b := remoteReview{ID: "id", Name: "reader", Detail: &mediabrowser.Observed{Policy: map[string]any{"EnableAllFolders": true, "EnabledFolders": []string{}, "BlockedTags": []string{"restricted"}}}}
	if bulkHash(a) == bulkHash(b) || p.bulkGrantProtection(a) != p.bulkGrantProtection(b) {
		t.Fatal("grant boundary incorrect")
	}
	b.Detail.(*mediabrowser.Observed).Policy["BlockedTags"] = []string{}
	if p.bulkGrantProtection(a) == p.bulkGrantProtection(b) {
		t.Fatal("restriction change ignored")
	}
}
func TestBulkProviderPlexUsesCloudMapping(t *testing.T) {
	for _, all := range []bool{false} {
		t.Run(fmt.Sprint(all), func(t *testing.T) {
			var responses map[string]string
			p, _ := plexShareFixture(t, func(m map[string]string) {
				responses = m
				m["http://fixture.invalid/library/sections"] = `<MediaContainer><Directory key="1" title="One"/><Directory key="2" title="Two"/></MediaContainer>`
				m["https://plex.tv/api/users/"] = `<MediaContainer size="1"><User id="42" username="Reader" allowSync="0" filterMovies="restricted"><Server id="700" machineIdentifier="machine-A" pending="0" owned="0"/></User></MediaContainer>`
			})
			original := p.client.Transport
			writes := 0
			p.client.Transport = providerTransport(func(r *http.Request) (*http.Response, error) {
				if r.Method == "PUT" {
					writes++
					if r.URL.String() != "https://plex.tv/api/servers/machine-A/shared_servers/700" {
						t.Fatal(r.URL)
					}
					var body struct {
						Server string `json:"server_id"`
						Share  struct {
							IDs []int64 `json:"library_section_ids"`
						} `json:"shared_server"`
					}
					json.NewDecoder(r.Body).Decode(&body)
					want := []int64{1002}
					if all {
						want = []int64{1001, 1002}
					}
					if body.Server != "machine-A" || !slices.Equal(body.Share.IDs, want) {
						t.Fatal("wrong cloud mapping", body)
					}
					flag := "0"
					first := "0"
					if all {
						flag = "1"
						first = "1"
					}
					responses["https://plex.tv/api/servers/machine-A/shared_servers"] = `<MediaContainer><SharedServer id="700" userID="42" allLibraries="` + flag + `"><Section key="1" shared="` + first + `"/><Section key="2" shared="1"/></SharedServer></MediaContainer>`
					return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("")), Request: r}, nil
				}
				return original.RoundTrip(r)
			})
			req := bulkProviderRequest{Action: "update_libraries", ID: "42", Name: "Reader", AllLibraries: all}
			if !all {
				req.LibraryIDs = []string{"2"}
			}
			snap, err := p.prepareBulkUser(t.Context(), req)
			if err != nil {
				t.Fatal(err)
			}
			result, err := p.executeBulkUser(t.Context(), req, snap, func(string) error { return nil })
			if err != nil || result.Outcome != "updated" || writes != 1 {
				t.Fatal(result, err, writes)
			}
		})
	}
}
func TestBulkProviderPlexFriendDeletionLostResponse(t *testing.T) {
	var responses map[string]string
	p, _ := plexShareFixture(t, func(m map[string]string) {
		responses = m
		m["https://plex.tv/api/users/"] = `<MediaContainer size="1"><User id="42" username="Reader" allowSync="0"/></MediaContainer>`
	})
	original := p.client.Transport
	writes := 0
	p.client.Transport = providerTransport(func(r *http.Request) (*http.Response, error) {
		if r.Method == "DELETE" {
			writes++
			if r.URL.String() != "https://plex.tv/api/v2/sharings/42" {
				t.Fatal("not friendship removal", r.URL)
			}
			responses["https://plex.tv/api/users/"] = `<MediaContainer size="0"/>`
			responses["https://plex.tv/api/servers/machine-A/shared_servers"] = `<MediaContainer size="0"/>`
			responses["https://plex.tv/api/invites/requested"] = `<MediaContainer size="0"/>`
			return nil, fmt.Errorf("fixture response lost")
		}
		return original.RoundTrip(r)
	})
	req := bulkProviderRequest{Action: "delete_users", ID: "42", Name: "Reader"}
	snap, err := p.prepareBulkUser(t.Context(), req)
	if err != nil {
		t.Fatal(err)
	}
	if snap.PlexOwner != "9001" || snap.PlexRecipient != "42" {
		t.Fatal("unverified grouping", snap)
	}
	result, err := p.executeBulkUser(t.Context(), req, snap, func(string) error { return nil })
	if err != nil || result.Outcome != "deleted" || writes != 1 {
		t.Fatal(result, err, writes)
	}
	absent, err := p.prepareBulkUser(t.Context(), req)
	if err != nil || !absent.Absent || absent.Group != snap.Group || absent.PlexOwner != snap.PlexOwner || absent.PlexRecipient != snap.PlexRecipient {
		t.Fatal("absent identity/group lost", absent, err)
	}
}
func TestBulkProviderKomgaPreservesRolesAndRestrictions(t *testing.T) {
	f := newKomgaProvisionFixture(t, "")
	f.created = true
	f.email = "reader@example.invalid"
	f.roles = []string{"USER", "PAGE_STREAMING", "FILE_DOWNLOAD"}
	f.libraries = []string{"old"}
	f.allow = []string{"allowed"}
	f.exclude = []string{"blocked"}
	f.age = &komga.AgeRestriction{Age: 16, Restriction: "EXCLUDE"}
	p := &serverConnection{config: ProviderConfig{Type: "komga", URL: f.server.URL + "/proxy", APIKey: "fixture-secret"}, client: f.server.Client()}
	req := bulkProviderRequest{Action: "update_libraries", ID: "komga-user", Name: f.email, LibraryIDs: []string{"komga-shelf"}}
	snap, err := p.prepareBulkUser(t.Context(), req)
	if err != nil {
		t.Fatal(err)
	}
	result, err := p.executeBulkUser(t.Context(), req, snap, func(string) error { return nil })
	if err != nil || result.Outcome != "updated" || !slices.Contains(f.roles, "PAGE_STREAMING") || !slices.Contains(f.roles, "FILE_DOWNLOAD") || len(f.exclude) != 1 {
		t.Fatal(result, err, f.roles)
	}
}
func TestBulkProviderPlexRejectsUnprovedDynamicAll(t *testing.T) {
	p, _ := plexShareFixture(t, func(m map[string]string) {
		m["http://fixture.invalid/library/sections"] = `<MediaContainer><Directory key="1" title="One"/><Directory key="2" title="Two"/></MediaContainer>`
		m["https://plex.tv/api/users/"] = `<MediaContainer size="1"><User id="42" username="Reader" allowSync="0"><Server id="700" machineIdentifier="machine-A" pending="0" owned="0"/></User></MediaContainer>`
	})
	if _, err := p.prepareBulkUser(t.Context(), bulkProviderRequest{Action: "update_libraries", ID: "42", Name: "Reader", AllLibraries: true}); err == nil {
		t.Fatal("unproved dynamic-all mutation admitted")
	}
}
func TestBulkProviderABSAndKavitaPreserveRestrictions(t *testing.T) {
	t.Run("audiobookshelf", func(t *testing.T) {
		f := newABSProvisionFixture(t, "")
		f.created = true
		f.active = true
		f.name = "Reader"
		f.permissions = map[string]bool{"download": true, "update": true, "delete": false, "upload": false, "createEreader": false, "accessAllLibraries": true, "accessAllTags": false, "accessExplicitContent": true, "selectedTagsNotAccessible": true}
		f.libraries = []string{}
		f.tags = []string{"restricted"}
		p := &serverConnection{config: ProviderConfig{Type: "audiobookshelf", URL: f.server.URL + "/proxy", APIKey: "fixture-secret"}, client: f.server.Client()}
		req := bulkProviderRequest{Action: "update_libraries", ID: "abs-user", Name: "Reader", LibraryIDs: []string{"abs-books"}}
		snap, err := p.prepareBulkUser(t.Context(), req)
		if err != nil {
			t.Fatal(err)
		}
		res, err := p.executeBulkUser(t.Context(), req, snap, func(string) error { return nil })
		if err != nil || res.Outcome != "updated" || !f.permissions["update"] || !f.permissions["download"] || len(f.tags) != 1 {
			t.Fatal(res, err)
		}
	})
	t.Run("kavita", func(t *testing.T) {
		f := newKavitaProvisionFixture(t, "")
		f.confirmed = true
		f.name = "Reader"
		f.roles = []string{"Pleb", "Login", "Download", "Bookmark"}
		f.libraries = []int64{}
		f.age = kavita.AgeRestriction{AgeRating: 12, IncludeUnknowns: false}
		p := &serverConnection{config: ProviderConfig{Type: "kavita", URL: f.server.URL, APIKey: "fixture-secret"}, client: f.server.Client()}
		req := bulkProviderRequest{Action: "update_libraries", ID: "17", Name: "Reader", LibraryIDs: []string{"2"}}
		snap, err := p.prepareBulkUser(t.Context(), req)
		if err != nil {
			t.Fatal(err)
		}
		res, err := p.executeBulkUser(t.Context(), req, snap, func(string) error { return nil })
		if err != nil || res.Outcome != "updated" || !slices.Contains(f.roles, "Bookmark") || f.age.AgeRating != 12 {
			t.Fatal(res, err)
		}
	})
}
func TestBulkProviderRecordedDeletionFixtures(t *testing.T) {
	for _, kind := range []string{"audiobookshelf", "komga", "kavita", "romm"} {
		t.Run(kind, func(t *testing.T) {
			var p *serverConnection
			var gone func()
			var id, name, path string
			switch kind {
			case "audiobookshelf":
				f := newABSProvisionFixture(t, "")
				f.created = true
				f.name = "Reader"
				f.permissions = map[string]bool{"download": false, "update": false, "delete": false, "upload": false, "createEreader": false, "accessAllLibraries": false, "accessAllTags": true, "accessExplicitContent": false, "selectedTagsNotAccessible": false}
				f.libraries = []string{}
				f.tags = []string{}
				p = &serverConnection{config: ProviderConfig{Type: kind, URL: f.server.URL + "/proxy", APIKey: "fixture-secret"}, client: f.server.Client()}
				gone = func() { f.absent = true }
				id = "abs-user"
				name = "Reader"
				path = "/proxy/api/users/abs-user"
			case "komga":
				f := newKomgaProvisionFixture(t, "")
				f.created = true
				f.email = "reader@example.invalid"
				f.roles = []string{"USER"}
				f.libraries = []string{}
				p = &serverConnection{config: ProviderConfig{Type: kind, URL: f.server.URL + "/proxy", APIKey: "fixture-secret"}, client: f.server.Client()}
				gone = func() { f.absent = true }
				id = "komga-user"
				name = f.email
				path = "/proxy/api/v2/users/komga-user"
			case "kavita":
				f := newKavitaProvisionFixture(t, "")
				f.confirmed = true
				f.name = "Reader"
				f.roles = []string{"Pleb"}
				f.libraries = []int64{}
				f.age = kavita.AgeRestriction{AgeRating: -1, IncludeUnknowns: true}
				p = &serverConnection{config: ProviderConfig{Type: kind, URL: f.server.URL, APIKey: "fixture-secret"}, client: f.server.Client()}
				gone = func() { f.absent = true }
				id = "17"
				name = "Reader"
				path = "/api/Users/delete-user?username=Reader"
			case "romm":
				f := newRomMProvisionFixture(t, "")
				f.created = true
				p = rommTestProvider(t, f)
				gone = func() { f.created = false }
				id = "2"
				name = "reader"
				path = "/proxy/api/users/2"
			}
			base := p.client.Transport
			if base == nil {
				base = http.DefaultTransport
			}
			writes := 0
			p.client.Transport = providerTransport(func(r *http.Request) (*http.Response, error) {
				if r.Method == "DELETE" {
					writes++
					if r.URL.RequestURI() != path {
						t.Fatal("incorrect delete identity", r.URL)
					}
					gone()
					return &http.Response{StatusCode: 204, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("")), Request: r}, nil
				}
				return base.RoundTrip(r)
			})
			req := bulkProviderRequest{Action: "delete_users", ID: id, Name: name}
			snap, err := p.prepareBulkUser(t.Context(), req)
			if err != nil {
				t.Fatal(err)
			}
			res, err := p.executeBulkUser(t.Context(), req, snap, func(string) error { return nil })
			if err != nil || res.Outcome != "deleted" || writes != 1 {
				t.Fatal(res, err, writes)
			}
		})
	}
}
func TestBulkProviderPlexExistingDynamicAllIsUnchanged(t *testing.T) {
	p, _ := plexShareFixture(t, func(m map[string]string) {
		m["http://fixture.invalid/library/sections"] = `<MediaContainer><Directory key="1" title="One"/><Directory key="2" title="Two"/></MediaContainer>`
		m["https://plex.tv/api/users/"] = `<MediaContainer size="1"><User id="42" username="Reader" allowSync="0"><Server id="700" machineIdentifier="machine-A" pending="0" owned="0"/></User></MediaContainer>`
		m["https://plex.tv/api/servers/machine-A/shared_servers"] = `<MediaContainer><SharedServer id="700" userID="42" allLibraries="1"><Section key="1" shared="1"/><Section key="2" shared="1"/></SharedServer></MediaContainer>`
	})
	req := bulkProviderRequest{Action: "update_libraries", ID: "42", Name: "Reader", AllLibraries: true}
	snap, err := p.prepareBulkUser(t.Context(), req)
	if err != nil {
		t.Fatal(err)
	}
	result, err := p.executeBulkUser(t.Context(), req, snap, func(string) error { t.Fatal("unchanged dispatched"); return nil })
	if err != nil || result.Outcome != "unchanged" {
		t.Fatal(result, err)
	}
}
func TestBulkProviderKavitaRejectsDuplicateNameInFinalObservation(t *testing.T) {
	f := newKavitaProvisionFixture(t, "")
	f.confirmed = true
	f.name = "Reader"
	f.roles = []string{"Pleb"}
	f.libraries = []int64{}
	f.age = kavita.AgeRestriction{AgeRating: -1, IncludeUnknowns: true}
	p := &serverConnection{config: ProviderConfig{Type: "kavita", URL: f.server.URL, APIKey: "fixture-secret"}, client: f.server.Client()}
	base := http.DefaultTransport
	reads := 0
	p.client.Transport = providerTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path == "/api/Users" {
			reads++
			// Bulk prepare reads the member list once, in the inspection that
			// decides the outcome; that observation carries the duplicate name.
			if reads == 1 {
				body := `[{"id":17,"username":"Reader","isPending":false,"identityProvider":0,"roles":["Pleb"],"libraries":[],"ageRestriction":{"ageRating":-1,"includeUnknowns":true}},{"id":18,"username":"reader"}]`
				return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
			}
		}
		return base.RoundTrip(r)
	})
	if _, err := p.prepareBulkUser(t.Context(), bulkProviderRequest{Action: "delete_users", ID: "17", Name: "Reader"}); err == nil {
		t.Fatal("ambiguous final Kavita name accepted")
	}
}
