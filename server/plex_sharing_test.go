package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
)

// Every URL, including fixed cloud hosts, is intercepted. No real service is used.
func plexShareFixture(t *testing.T, mutate func(map[string]string)) (*serverConnection, *int) {
	t.Helper()
	responses := map[string]string{
		"http://fixture.invalid/":                              `<MediaContainer machineIdentifier="machine-A"/>`,
		"http://fixture.invalid/library/sections":              `<MediaContainer><Directory key="1"/><Directory key="2"/></MediaContainer>`,
		"https://plex.tv/api/servers/machine-A":                `<MediaContainer><Server machineIdentifier="machine-A"><Section id="1001" key="1"/><Section id="1002" key="2"/></Server></MediaContainer>`,
		"https://plex.tv/api/users/":                           `<MediaContainer><User id="42" allowSync="0"><Server id="700" machineIdentifier="machine-A" pending="0" owned="1"/></User></MediaContainer>`,
		"https://plex.tv/users/account":                        `<user id="9001" username="ServerOwner" email="owner@example.invalid"/>`,
		"https://plex.tv/api/servers/machine-A/shared_servers": `<MediaContainer><SharedServer id="700" userID="42" allLibraries="0" accessToken="never-retain"><Section key="1" shared="1"/><Section key="2" shared="0"/></SharedServer></MediaContainer>`,
	}
	if mutate != nil {
		mutate(responses)
	}
	count := 0
	client := &http.Client{Transport: providerTransport(func(r *http.Request) (*http.Response, error) {
		count++
		if r.Method != "GET" || r.URL.RawQuery != "" || r.Header.Get("X-Plex-Token") != "fixture-secret" {
			t.Error("unsafe sharing request", r.Method, r.URL.Path)
		}
		if err := r.Context().Err(); err != nil {
			return nil, err
		}
		body, ok := responses[r.URL.String()]
		if !ok {
			t.Error("unexpected sharing target", r.URL)
			return nil, errors.New("unexpected fixture request")
		}
		status := 200
		if body == "FAIL" {
			status = 503
			body = "private-upstream-token"
		}
		return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
	})}
	provider, err := newServerConnection(ProviderConfig{Type: "plex", URL: "http://fixture.invalid", APIKey: "fixture-secret"}, client)
	if err != nil {
		t.Fatal(err)
	}
	return provider, &count
}
func TestPlexSharePreflightMapsCloudIDsAndExactAcceptedAccess(t *testing.T) {
	p, count := plexShareFixture(t, nil)
	grant := InvitationGrant{LibraryIDs: []string{"1"}}
	got, err := p.inspectPlexShare(t.Context(), "42", grant)
	if err != nil || !plexShareMatches(got, grant) || *count != 5 {
		t.Fatal(got, err, *count)
	}
	if got.Machine != "machine-A" || got.Account != "42" || got.ShareID != "700" || len(got.Sections) != 1 || got.Sections[0] != (plexShareSection{"1", "1001"}) {
		t.Fatal("identity/section mapping lost", got)
	}
	grant.AllowDownloads = true
	if plexShareMatches(got, grant) {
		t.Fatal("download mismatch accepted")
	}
	grant = InvitationGrant{LibraryIDs: []string{"1", "2"}}
	if plexShareMatches(got, grant) {
		t.Fatal("missing selected library accepted")
	}
}
func TestPlexSharePreflightPendingAndUnobservedAreNeverAccepted(t *testing.T) {
	for _, mode := range []string{"pending", "unobserved", "pending-no-share"} {
		t.Run(mode, func(t *testing.T) {
			p, _ := plexShareFixture(t, func(m map[string]string) {
				u := "https://plex.tv/api/users/"
				if mode == "unobserved" {
					m[u] = `<MediaContainer/>`
				} else {
					m[u] = strings.ReplaceAll(m[u], `pending="0"`, `pending="1"`)
				}
				if mode != "pending" {
					m["https://plex.tv/api/servers/machine-A/shared_servers"] = `<MediaContainer/>`
				}
			})
			grant := InvitationGrant{LibraryIDs: []string{"1"}}
			got, err := p.inspectPlexShare(t.Context(), "42", grant)
			if err != nil || plexShareMatches(got, grant) {
				t.Fatal(got, err)
			}
			expected := "pending"
			if mode == "unobserved" {
				expected = "unobserved"
			}
			if got.State != expected {
				t.Fatal(got)
			}
		})
	}
}
func TestPlexSharePreflightRejectsAmbiguousOrIncompleteSnapshots(t *testing.T) {
	const c = "https://plex.tv/api/servers/machine-A"
	const u = "https://plex.tv/api/users/"
	cases := []struct{ name, target, old, new string }{
		{"wrong-machine", c, `machineIdentifier="machine-A"`, `machineIdentifier="other"`},
		{"duplicate-cloud-key", c, `key="2"`, `key="1"`},
		{"duplicate-cloud-id", c, `id="1002"`, `id="1001"`},
		{"noncanonical-cloud-id", c, `id="1001"`, `id="01001"`},
		{"missing-cloud-map", c, `key="1"`, `key="3"`},
		{"duplicate-local-key", "http://fixture.invalid/library/sections", `key="2"`, `key="1"`},
		{"missing-pending", u, `pending="0"`, ``},
		{"unknown-pending", u, `pending="0"`, `pending="maybe"`},
		{"not-owned-reference", u, `owned="1"`, `owned="0"`},
		{"unknown-owner", u, `owned="1"`, ``},
		{"wrong-share-reference", u, `id="700"`, `id="701"`},
		{"missing-downloads", u, `allowSync="0"`, ``},
		{"duplicate-user", u, `</MediaContainer>`, `<User id="42"/></MediaContainer>`},
		{"duplicate-reference", u, `</User>`, `<Server id="700" machineIdentifier="machine-A" pending="0" owned="1"/></User>`},
		{"invalid-share-id", c + "/shared_servers", `id="700"`, `id="../42"`},
		{"unknown-all", c + "/shared_servers", `allLibraries="0"`, ``},
		{"unknown-section-state", c + "/shared_servers", `shared="0"`, `shared="maybe"`},
		{"unknown-library", c + "/shared_servers", `key="2"`, `key="99"`},
		{"duplicate-section", c + "/shared_servers", `key="2"`, `key="1"`},
		{"duplicate-share", c + "/shared_servers", `</MediaContainer>`, `<SharedServer id="701" userID="42" allLibraries="0"/></MediaContainer>`},
		{"missing-accepted-share", c + "/shared_servers", `userID="42"`, `userID="43"`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p, _ := plexShareFixture(t, func(m map[string]string) { m[tc.target] = strings.ReplaceAll(m[tc.target], tc.old, tc.new) })
			if _, err := p.inspectPlexShare(t.Context(), "42", InvitationGrant{LibraryIDs: []string{"1"}}); err == nil {
				t.Fatal("ambiguous snapshot accepted")
			}
		})
	}
}
func TestPlexSharePreflightAllLibrariesAndExtraAccess(t *testing.T) {
	p, _ := plexShareFixture(t, func(m map[string]string) {
		key := "https://plex.tv/api/servers/machine-A/shared_servers"
		m[key] = strings.ReplaceAll(m[key], `allLibraries="0"`, `allLibraries="1"`)
	})
	grant := InvitationGrant{AllLibraries: true}
	got, err := p.inspectPlexShare(t.Context(), "42", grant)
	if err != nil || !plexShareMatches(got, grant) || len(got.Sections) != 2 {
		t.Fatal(got, err)
	}
	p, _ = plexShareFixture(t, func(m map[string]string) {
		key := "https://plex.tv/api/servers/machine-A/shared_servers"
		m[key] = strings.ReplaceAll(m[key], `shared="0"`, `shared="1"`)
	})
	grant = InvitationGrant{LibraryIDs: []string{"1"}}
	got, err = p.inspectPlexShare(t.Context(), "42", grant)
	if err != nil || plexShareMatches(got, grant) {
		t.Fatal("extra selected access accepted", got, err)
	}
	p, _ = plexShareFixture(t, func(m map[string]string) {
		key := "https://plex.tv/api/servers/machine-A"
		m[key] = strings.ReplaceAll(m[key], `</Server>`, `<Section id="1003" key="3"/></Server>`)
	})
	// plex.tv may list a stale library the server no longer has: it is ignored
	// and never shared, and only the server's own libraries are shared.
	got, err = p.inspectPlexShare(t.Context(), "42", InvitationGrant{AllLibraries: true})
	if err != nil || len(got.Sections) != 2 || got.Sections[0].CloudID != "1001" || got.Sections[1].CloudID != "1002" {
		t.Fatal("cloud-only library should be ignored, not shared", got.Sections, err)
	}
}
func TestPlexSharePreflightRejectsInvalidGrantsBeforeHTTP(t *testing.T) {
	for _, grant := range []InvitationGrant{{}, {AllLibraries: true, LibraryIDs: []string{"1"}}} {
		p, count := plexShareFixture(t, nil)
		if _, err := p.inspectPlexShare(t.Context(), "42", grant); err == nil || *count != 0 {
			t.Fatal("invalid grant reached upstream")
		}
	}
	for _, id := range []string{"", "0", "042", "../42", "42?token=secret"} {
		p, count := plexShareFixture(t, nil)
		if _, err := p.inspectPlexShare(t.Context(), id, InvitationGrant{AllLibraries: true}); err == nil || *count != 0 {
			t.Fatal("invalid account reached upstream")
		}
	}
	p, _ := plexShareFixture(t, nil)
	if _, err := p.inspectPlexShare(t.Context(), "42", InvitationGrant{LibraryIDs: []string{"1", "1"}}); err == nil {
		t.Fatal("duplicate selection accepted")
	}
}
func TestPlexSharePreflightFailureIsRedactedAndNeverRetried(t *testing.T) {
	p, count := plexShareFixture(t, func(m map[string]string) { m["https://plex.tv/api/servers/machine-A"] = "FAIL" })
	_, err := p.inspectPlexShare(t.Context(), "42", InvitationGrant{AllLibraries: true})
	if !errors.Is(err, errPlexShare) || *count != 3 || strings.Contains(err.Error(), "private") {
		t.Fatal(err, *count)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	p, count = plexShareFixture(t, nil)
	if _, err = p.inspectPlexShare(ctx, "42", InvitationGrant{AllLibraries: true}); !errors.Is(err, errPlexShare) || *count != 1 {
		t.Fatal(err, *count)
	}
}

func TestPlexSyncRejectsUnknownAcceptanceAndAmbiguousLibraryPolicy(t *testing.T) {
	const u = "https://plex.tv/api/users/"
	const sh = "https://plex.tv/api/servers/machine-A/shared_servers"
	cases := []struct{ name, target, old, new string }{
		{"missing-pending", u, `pending="0"`, ``},
		{"unknown-pending", u, `pending="0"`, `pending="unknown"`},
		{"duplicate-reference", u, `</User>`, `<Server machineIdentifier="machine-A" pending="1"/></User>`},
		{"duplicate-user", u, `</MediaContainer>`, `<User id="42"><Server machineIdentifier="machine-A" pending="0"/></User></MediaContainer>`},
		{"missing-all", sh, `allLibraries="0"`, ``},
		{"unknown-shared", sh, `shared="0"`, `shared="maybe"`},
		{"duplicate-library", sh, `key="2"`, `key="1"`},
		{"owner-unavailable", "https://plex.tv/users/account", `<user id="9001" username="ServerOwner" email="owner@example.invalid"/>`, `FAIL`},
		{"owner-incomplete", "https://plex.tv/users/account", `id="9001" `, ``},
		{"shared-user-claims-owner-id", u, `User id="42"`, `User id="1"`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p, _ := plexShareFixture(t, func(m map[string]string) { m[tc.target] = strings.ReplaceAll(m[tc.target], tc.old, tc.new) })
			if _, err := p.plexServer().Users(t.Context()); err == nil {
				t.Fatal("sync accepted incomplete access snapshot")
			}
		})
	}
	p, _ := plexShareFixture(t, nil)
	users, err := p.plexServer().Users(t.Context())
	// The server owner comes first as local account 1 with every library.
	if err != nil || len(users) != 2 || users[0].ID != "1" || !users[0].AllLibraries || users[0].Name != "ServerOwner" || users[1].ID != "42" || !users[1].Active {
		t.Fatal(users, err)
	}
}
