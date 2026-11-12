package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const plexPlaying = `<MediaContainer size="1"><Video sessionKey="10" ratingKey="123" type="movie" title="Fixture movie" duration="10000" viewOffset="2000"><User id="42" title="Viewer"/><Player state="playing" product="Plex Web" title="Private device"/></Video></MediaContainer>`

func TestPlexActivityParser(t *testing.T) {
	s, err := parseActivitySnapshot("plex", []byte(plexPlaying))
	if err != nil || len(s.Sessions) != 1 || *s.Sessions[0].Position != 20000000 || s.Sessions[0].User != "42" {
		t.Fatal(s, err)
	}
	for _, body := range []string{`<MediaContainer/>`, strings.Replace(plexPlaying, `size="1"`, `size="2"`, 1), strings.Replace(plexPlaying, `id="42"`, `id="42" id="43"`, 1), strings.Replace(plexPlaying, `state="playing"`, `state="broken"`, 1)} {
		if _, err := parseActivitySnapshot("plex", []byte(body)); err == nil {
			t.Fatal("incomplete Plex sessions accepted")
		}
	}
}
func TestPlexMonitoringObservesUnlinkedIdentityWithoutAdoption(t *testing.T) {
	a, s := testApp(t)
	var logs bytes.Buffer
	a.logger = slog.New(slog.NewTextHandler(&logs, nil))
	token, _ := bootstrapOwner(t, a)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Plex-Token") != "fixture-secret" {
			t.Error("credential not in header")
		}
		switch r.URL.Path {
		case "/":
			fmt.Fprint(w, `<MediaContainer friendlyName="Fixture" version="1" machineIdentifier="fixture-machine"/>`)
		case "/library/sections":
			fmt.Fprint(w, `<MediaContainer/>`)
		case "/status/sessions":
			fmt.Fprint(w, plexPlaying)
		default:
			t.Error("unexpected provider request", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer upstream.Close()
	server := createManagedServer(t, a, token, "plex", upstream.URL)
	configureTestMonitor(t, a, token, server, true)
	if err := a.runOneActivityMonitor(t.Context()); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(logs.String(), "Activity poll completed") || !strings.Contains(logs.String(), "sessions=1") || strings.Contains(logs.String(), "Private device") || strings.Contains(logs.String(), "fixture-secret") {
		t.Fatal("missing safe poll summary", logs.String())
	}
	var current, links int
	s.reader.QueryRow("SELECT count(*) FROM media_activity_current WHERE server_id=?", server).Scan(&current)
	s.reader.QueryRow("SELECT count(*) FROM service_links").Scan(&links)
	if current != 1 || links != 0 {
		t.Fatal("activity missing or ownership inferred", current, links)
	}
	w := apiRequest(a, "GET", "/api/activity/current?scope=all", token, nil, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var view struct{ Data activityReadResponse }
	if err := json.Unmarshal(w.Body.Bytes(), &view); err != nil || len(view.Data.Items) != 1 || view.Data.Servers[0].Freshness != "fresh" {
		t.Fatal(w.Body.String(), err)
	}
	a.ProviderHTTP = &http.Client{Transport: providerTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host == "plex.tv" {
			body := `<MediaContainer/>`
			if r.URL.Path == "/users/account" {
				body = `<user id="9001" username="ServerOwner"/>`
			}
			return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
		}
		if !strings.HasPrefix(r.URL.Host, "127.0.0.1:") {
			t.Fatal("unexpected external host")
		}
		return http.DefaultTransport.RoundTrip(r)
	})}
	if w := apiRequest(a, "POST", fmt.Sprintf("/api/servers/%d/sync-users", server), token, nil, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var active bool
	if err := s.reader.QueryRow("SELECT is_active FROM service_accounts WHERE server_id=? AND external_user_id='42'", server).Scan(&active); err != nil || !active {
		t.Fatal("friend snapshot disabled observation-only identity", active, err)
	}
	activityExec(t, s, "UPDATE service_accounts SET is_active=0 WHERE server_id=?", server)
	activityExec(t, s, "UPDATE activity_monitor_schedules SET next_run_at='2000-01-01T00:00:00Z' WHERE server_id=?", server)
	if err := a.runOneActivityMonitor(t.Context()); err != nil {
		t.Fatal(err)
	}
	s.reader.QueryRow("SELECT is_active FROM service_accounts WHERE server_id=? AND external_user_id='42'", server).Scan(&active)
	if active {
		t.Fatal("polling reactivated an inactive account")
	}

}

func TestOwnerServerCreationEnablesMonitoringByDefault(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	for _, provider := range []string{"plex", "jellyfin", "emby"} {
		server := createManagedServer(t, a, token, provider, "http://127.0.0.1:1")
		var enabled bool
		var actor string
		var revision, configRevision int64
		if err := s.reader.QueryRow(`SELECT q.enabled,q.authorized_by,q.configured_server_revision,s.config_revision FROM activity_monitor_schedules q JOIN media_servers s ON s.id=q.server_id WHERE q.server_id=?`, server).Scan(&enabled, &actor, &revision, &configRevision); err != nil {
			t.Fatal(err)
		}
		if !enabled || actor == "" || revision != configRevision {
			t.Fatal("owner-added source not scheduled", provider)
		}
		configureTestMonitor(t, a, token, server, false)
		if err := s.reader.QueryRow("SELECT enabled FROM activity_monitor_schedules WHERE server_id=?", server).Scan(&enabled); err != nil || enabled {
			t.Fatal("explicit disable not retained", err)
		}
	}
}

func TestDelegatedServerCreationDoesNotInventOwnerAuthorization(t *testing.T) {
	a, s, _, token, _ := roleReadFixture(t)
	server := createManagedServer(t, a, token, "plex", "http://127.0.0.1:1")
	var enabled bool
	var authorized bool
	if err := s.reader.QueryRow("SELECT enabled,authorized_by IS NOT NULL FROM activity_monitor_schedules WHERE server_id=?", server).Scan(&enabled, &authorized); err != nil || enabled || authorized {
		t.Fatal("delegated creation invented owner authority", enabled, authorized, err)
	}
}
