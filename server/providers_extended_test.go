package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

type providerTransport func(*http.Request) (*http.Response, error)

func (f providerTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// Plex cloud traffic is intercepted here; these tests never contact plex.tv.
func extendedProviderFixture(t *testing.T, kind string) (*httptest.Server, *http.Client, *atomic.Int32) {
	t.Helper()
	if kind == "romm" {
		f := newRomMPermissionFixture(t, "")
		return f.server, f.server.Client(), &f.mode
	}
	mode := &atomic.Int32{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := r.Header.Get("X-API-Key")
		if kind == "plex" {
			key = r.Header.Get("X-Plex-Token")
		}
		if kind == "romm" || kind == "audiobookshelf" {
			key = strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		}
		if key != "fixture-secret" || r.URL.RawQuery != "" {
			t.Error("missing header authentication or unexpected query credentials")
			http.Error(w, "bad key", 401)
			return
		}
		isUsers := strings.HasSuffix(r.URL.Path, "/users") || r.URL.Path == "/cloud/api/users/"
		if isUsers && mode.Load() == 1 {
			http.Error(w, "upstream-private-token", 503)
			return
		}
		if isUsers && mode.Load() == 2 {
			fmt.Fprint(w, `null`)
			return
		}
		switch r.URL.Path {
		case "/proxy/api/v1/libraries":
			fmt.Fprint(w, `[{"id":"shelf","name":"Comics"}]`)
		case "/proxy/api/v2/users":
			if mode.Load() == 3 {
				fmt.Fprint(w, `[{"id":"reader","email":"reader@example.invalid"}]`)
				return
			}
			fmt.Fprint(w, `[{"id":"reader","email":"reader@example.invalid","roles":["USER","PAGE_STREAMING"],"sharedAllLibraries":false,"sharedLibrariesIds":["shelf"]}]`)
		case "/proxy/api/libraries":
			fmt.Fprint(w, `{"libraries":[{"id":"shelf","name":"Books","mediaType":"book"}]}`)
		case "/proxy/api/platforms":
			fmt.Fprint(w, `[{"id":7,"name":"NES","rom_count":12}]`)
		case "/proxy/api/users":
			if kind == "romm" {
				if mode.Load() == 3 {
					fmt.Fprint(w, `[{"id":2,"username":"Reader"}]`)
					return
				}
				fmt.Fprint(w, `[{"id":2,"username":"Reader","enabled":true,"email":"reader@example.invalid","hashed_password":"never-persist"}]`)
			} else {
				if mode.Load() == 3 {
					fmt.Fprint(w, `{"users":[{"id":"reader","username":"Reader","isActive":true}]}`)
					return
				}
				fmt.Fprint(w, `{"users":[{"id":"reader","username":"Reader","isActive":true,"isLocked":false,"librariesAccessible":["shelf"],"permissions":{"accessAllLibraries":false},"token":"never-persist"}]}`)
			}
		case "/proxy/":
			fmt.Fprint(w, `<MediaContainer friendlyName="Fixture" version="1" machineIdentifier="fixture-machine"/>`)
		case "/proxy/library/sections":
			fmt.Fprint(w, `<MediaContainer><Directory key="shelf" title="Movies" type="movie"/></MediaContainer>`)
		case "/cloud/api/users/":
			fmt.Fprint(w, `<MediaContainer><User id="2" username="Reader" email="reader@example.invalid"><Server machineIdentifier="fixture-machine" pending="0"/></User><User id="3" title="Pending"><Server machineIdentifier="fixture-machine" pending="1"/></User><User id="4" username="Other"><Server machineIdentifier="other-server"/></User></MediaContainer>`)
		case "/cloud/users/account":
			// The account that owns the token, which owns the server.
			if mode.Load() == 4 {
				http.Error(w, "unavailable", http.StatusServiceUnavailable)
				return
			}
			fmt.Fprint(w, `<user id="9001" uuid="0123456789abcdef" username="ServerOwner" title="ServerOwner" email="owner@example.invalid" thumb="https://plex.tv/users/0123456789abcdef/avatar?c=5" authToken="never-persist"/>`)
		case "/cloud/api/servers/fixture-machine/shared_servers":
			if mode.Load() == 3 {
				fmt.Fprint(w, `<MediaContainer/>`)
				return
			}
			fmt.Fprint(w, `<MediaContainer><SharedServer userID="2" allLibraries="0" accessToken="never-persist"><Section key="shelf" shared="1"/><Section key="private" shared="0"/></SharedServer></MediaContainer>`)
		default:
			t.Errorf("unexpected provider endpoint %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(upstream.Close)
	client := upstream.Client()
	if kind == "plex" {
		base := client.Transport
		if base == nil {
			base = http.DefaultTransport
		}
		client.Transport = providerTransport(func(r *http.Request) (*http.Response, error) {
			if r.URL.Host == "plex.tv" {
				if r.URL.Scheme != "https" {
					t.Fatal("cloud request requires HTTPS")
				}
				copy := r.Clone(r.Context())
				urlCopy := *r.URL
				copy.URL = &urlCopy
				copy.URL.Scheme = "http"
				copy.URL.Host = strings.TrimPrefix(upstream.URL, "http://")
				copy.URL.Path = "/cloud" + r.URL.Path
				return base.RoundTrip(copy)
			}
			if r.URL.Host != strings.TrimPrefix(upstream.URL, "http://") {
				t.Fatal("unexpected network target")
			}
			return base.RoundTrip(r)
		})
	}
	return upstream, client, mode
}

func TestRemainingProviderSnapshotSync(t *testing.T) {
	for _, kind := range []string{"plex", "audiobookshelf", "komga", "romm"} {
		t.Run(kind, func(t *testing.T) {
			upstream, client, mode := extendedProviderFixture(t, kind)
			a, s := testApp(t)
			a.ProviderHTTP = client
			token, _ := bootstrapOwner(t, a)
			id := createManagedServer(t, a, token, kind, upstream.URL+"/proxy")
			if w := apiRequest(a, "POST", fmt.Sprintf("/api/servers/%d/test-connection", id), token, nil, nil); w.Code != 200 {
				t.Fatal(w.Code, w.Body.String())
			}
			path := fmt.Sprintf("/api/servers/%d/sync", id)
			for range 2 {
				if w := apiRequest(a, "POST", path, token, nil, nil); w.Code != 200 {
					t.Fatal(w.Code, w.Body.String())
				}
			}
			var count, active int
			if err := s.reader.QueryRow("SELECT count(*),sum(is_active) FROM service_accounts WHERE server_id=?", id).Scan(&count, &active); err != nil {
				t.Fatal(err)
			}
			// Plex also lists a pending invitee and the server owner (local account 1).
			want, wantActive := 1, 1
			if kind == "plex" {
				want, wantActive = 3, 2
			}
			if count != want || active != wantActive {
				t.Fatalf("accounts=%d active=%d", count, active)
			}
			var settings, ids string
			if err := s.reader.QueryRow("SELECT service_settings,allowed_library_ids FROM service_accounts WHERE server_id=? AND is_active=1 AND external_user_id<>'1'", id).Scan(&settings, &ids); err != nil {
				t.Fatal(err)
			}
			if kind == "romm" {
				if !strings.Contains(settings, `"library_policy_known":true`) || !strings.Contains(settings, `"all_libraries":true`) || !strings.Contains(settings, `"download_policy_known":true`) {
					t.Fatal(settings)
				}
			} else if ids != `["shelf"]` {
				t.Fatal(ids)
			}
			for _, invalid := range []int32{1, 2, 3} {
				mode.Store(invalid)
				w := apiRequest(a, "POST", path, token, nil, nil)
				if w.Code == 200 || strings.Contains(w.Body.String(), "upstream-private-token") {
					t.Fatal(w.Code, w.Body.String())
				}
				var after int
				if err := s.reader.QueryRow("SELECT sum(is_active) FROM service_accounts WHERE server_id=?", id).Scan(&after); err != nil || after != active {
					t.Fatal("failed snapshot changed accounts", err, after)
				}
			}
			for _, table := range []string{"service_accounts", "audit_events", "log_entries"} {
				rows, err := s.reader.Query("SELECT * FROM " + table)
				if err != nil {
					t.Fatal(err)
				}
				cols, _ := rows.Columns()
				for rows.Next() {
					values := make([]any, len(cols))
					targets := make([]any, len(cols))
					for i := range targets {
						targets[i] = &values[i]
					}
					if err := rows.Scan(targets...); err != nil {
						t.Fatal(err)
					}
					if strings.Contains(fmt.Sprint(values), "never-persist") {
						t.Fatal("raw provider secret persisted")
					}
				}
				if err := rows.Err(); err != nil {
					t.Fatal(err)
				}
				rows.Close()
			}
		})
	}
}

func TestRemainingProviderCancellationAndRedirects(t *testing.T) {
	for _, kind := range []string{"plex", "audiobookshelf", "komga", "romm"} {
		t.Run(kind, func(t *testing.T) {
			var requests atomic.Int32
			client := &http.Client{Transport: providerTransport(func(r *http.Request) (*http.Response, error) {
				requests.Add(1)
				return &http.Response{StatusCode: 302, Header: http.Header{"Location": {"https://unexpected.invalid/"}}, Body: io.NopCloser(strings.NewReader("private-response")), Request: r}, nil
			})}
			p, err := newServerConnection(ProviderConfig{kind, "https://fixture.invalid", "fixture-secret"}, client)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := p.Test(t.Context()); err == nil || strings.Contains(err.Error(), "private-response") {
				t.Fatal(err)
			}
			if requests.Load() != 1 {
				t.Fatal("redirect followed")
			}
			upstream, httpClient, _ := extendedProviderFixture(t, kind)
			p, _ = newServerConnection(ProviderConfig{kind, upstream.URL + "/proxy", "fixture-secret"}, httpClient)
			ctx, cancel := context.WithCancel(t.Context())
			cancel()
			if _, err := p.Users(ctx); err == nil {
				t.Fatal("canceled request succeeded")
			}
		})
	}
}
