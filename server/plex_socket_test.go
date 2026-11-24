package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

func TestPlexSocketTriggersCompleteSnapshotsWithoutLeakingFrames(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	var playing atomic.Bool
	playing.Store(true)
	var reads atomic.Int64
	connections := make(chan *websocket.Conn, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Plex-Token") != "fixture-secret" || r.URL.RawQuery != "" {
			t.Error("Plex credentials must be header-only")
		}
		switch r.URL.Path {
		case "/proxy/library/metadata/123":
			fmt.Fprint(w, plexSingleOriginalSource)
		case "/proxy/status/sessions":
			reads.Add(1)
			if playing.Load() {
				fmt.Fprint(w, plexRichPlaying)
			} else {
				fmt.Fprint(w, `<MediaContainer size="0"/>`)
			}
		case "/proxy/:/websockets/notifications":
			c, err := websocket.Accept(w, r, nil)
			if err != nil {
				return
			}
			defer c.CloseNow()
			// Plex is passive and may send JSON in a binary frame. No SessionsStart.
			if err := c.Write(r.Context(), websocket.MessageBinary, []byte(`{"NotificationContainer":{"type":"playing","private":"never persist fixture-secret"}}`)); err != nil {
				return
			}
			connections <- c
			var unexpected any
			if err := wsjson.Read(r.Context(), c, &unexpected); err == nil {
				t.Error("unexpected Plex subscription payload")
			}
		default:
			// Automatic library and user refreshes can run on startup too.
			w.WriteHeader(404)
		}
	}))
	defer func() { a.CloseScheduler(); upstream.Close() }()
	server := createManagedServer(t, a, token, "plex", upstream.URL+"/proxy")
	view := monitorSnapshot(t, a, token)
	task := view["tasks"].([]any)[0].(map[string]any)
	body := monitorChange(view["actor_uuid"].(string), task, true)
	body["socket_enabled"] = true
	body["interval_seconds"] = 300
	if w := apiRequest(a, "PUT", fmt.Sprintf("/api/settings/activity-monitoring/%d", server), token, body, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if err := a.StartScheduler(); err != nil {
		t.Fatal(err)
	}
	waitProviderSocket(t, func() bool {
		var source string
		var count int
		s.reader.QueryRow("SELECT observed_source FROM media_activity_state WHERE server_id=?", server).Scan(&source)
		s.reader.QueryRow("SELECT count(*) FROM media_activity_current WHERE server_id=?", server).Scan(&count)
		return source == "ws" && count == 1
	})
	var c *websocket.Conn
	select {
	case c = <-connections:
	case <-time.After(2 * time.Second):
		t.Fatal("no Plex connection")
	}
	playing.Store(false)
	// The stop notification's arrival time becomes the play's stop time,
	// not the previous read.
	stopSent := time.Now().UTC()
	if err := wsjson.Write(t.Context(), c, map[string]any{"NotificationContainer": map[string]any{"type": "playing", "PlaySessionStateNotification": []any{map[string]string{"sessionKey": "10", "ratingKey": "123", "state": "stopped", "secret": "never persist"}}}}); err != nil {
		t.Fatal(err)
	}
	waitProviderSocket(t, func() bool {
		var count int
		s.reader.QueryRow("SELECT count(*) FROM media_activity_current WHERE server_id=?", server).Scan(&count)
		return count == 0 && reads.Load() >= 2
	})
	var stopped string
	if err := s.reader.QueryRow("SELECT last_seen_at FROM media_activity_history WHERE server_id=?", server).Scan(&stopped); err != nil {
		t.Fatal(err)
	}
	if at, err := time.Parse(time.RFC3339Nano, stopped); err != nil || at.Before(stopSent) || at.After(time.Now()) {
		t.Fatalf("stop time %s, sent at %s", stopped, utcTimestamp(stopSent))
	}
	a.StopScheduler()
	if err := a.WaitScheduler(t.Context()); err != nil {
		t.Fatal(err)
	}
	if err := a.queue.Shutdown(t.Context()); err != nil {
		t.Fatal(err)
	}
	var payload string
	if err := s.reader.QueryRow("SELECT coalesce(group_concat(payload),'') FROM log_entries WHERE source='plex.socket'").Scan(&payload); err != nil {
		t.Fatal(err)
	}
	if payload == "" || strings.Contains(payload, "fixture-secret") || strings.Contains(payload, "never persist") || strings.Contains(payload, "stopped") {
		t.Fatal("raw frame persisted", payload)
	}
	response := apiRequest(a, "GET", "/api/activity/current?scope=all", token, nil, nil)
	var result struct{ Data activityReadResponse }
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil || result.Data.Servers[0].Source != "ws" {
		t.Fatal(response.Body.String(), err)
	}
}

func TestPlexSocketReconnectClearsOldError(t *testing.T) {
	w := &providerSocketWorker{}
	w.status("backoff", "TRANSPORT_FAILED")
	w.status("connected", "")
	if w.code != "" {
		t.Fatal("connected socket retained old error")
	}
}

func TestPlexSocketFailureKeepsHTTPPolling(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	var attempts atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/library/metadata/123" {
			fmt.Fprint(w, plexSingleOriginalSource)
			return
		}
		if r.URL.Path == "/status/sessions" {
			fmt.Fprint(w, plexRichPlaying)
			return
		}
		attempts.Add(1)
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer func() { a.CloseScheduler(); upstream.Close() }()
	server := createManagedServer(t, a, token, "plex", upstream.URL)
	if err := a.StartScheduler(); err != nil {
		t.Fatal(err)
	}
	waitProviderSocket(t, func() bool {
		var count int
		var source string
		s.reader.QueryRow("SELECT count(*) FROM media_activity_current WHERE server_id=?", server).Scan(&count)
		s.reader.QueryRow("SELECT observed_source FROM media_activity_state WHERE server_id=?", server).Scan(&source)
		return count == 1 && source == "http" && attempts.Load() >= 2
	})
}
