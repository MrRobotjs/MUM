package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

func TestProviderSocketEnvelopeAndURLBoundaries(t *testing.T) {
	for _, tc := range []struct {
		name, input, want string
		invalid           bool
	}{
		{"session", `{"MessageType":"Sessions","Data":[]}`, "Sessions", false},
		{"incremental", `{"MessageType":"PlaybackProgress","Data":{"private":"never logged"}}`, "PlaybackProgress", false},
		{"unknown", `{"MessageType":"Other","Data":"private"}`, "", false},
		{"keepalive", `{"MessageType":"ForceKeepAlive"}`, "ForceKeepAlive", false},
		{"duplicate", `{"MessageType":"Sessions","MessageType":"Other"}`, "", true},
		{"lowercase", `{"messagetype":"Sessions"}`, "", true},
		{"null", `null`, "", true}, {"oversized", strings.Repeat(" ", 65537), "", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := providerSocketHint([]byte(tc.input))
			if (err != nil) != tc.invalid || got != tc.want {
				t.Fatal(got, err)
			}
		})
	}
	for _, provider := range []string{"jellyfin", "emby"} {
		s := ManagedServer{Type: provider, URL: "https://media.example/base", apiKey: "private +&?"}
		endpoint, err := providerSocketURL(s, "device")
		if err != nil {
			t.Fatal(err)
		}
		u, _ := url.Parse(endpoint)
		want := "/base"
		if provider == "jellyfin" {
			want += "/socket"
		}
		if u.Scheme != "wss" || u.Path != want || u.Query().Get("api_key") != s.apiKey {
			t.Fatal("incorrect endpoint")
		}
	}
	if _, err := providerSocketURL(ManagedServer{Type: "jellyfin", URL: "http://user:pass@example.test", apiKey: "key"}, "device"); err == nil {
		t.Fatal("accepted userinfo")
	}
}

func waitProviderSocket(t *testing.T, predicate func() bool) {
	t.Helper()
	until := time.Now().Add(8 * time.Second)
	for !predicate() {
		if time.Now().After(until) {
			t.Fatal("socket condition timed out")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestProviderSocketRuntimeQueuesRedactedHintsAndReconcilesCompleteHTTP(t *testing.T) {
	for _, provider := range []string{"jellyfin", "emby"} {
		t.Run(provider, func(t *testing.T) {
			a, s := testApp(t)
			token, _ := bootstrapOwner(t, a)
			owner, _ := s.Authenticate(t.Context(), token)
			var service string
			var reads, connections atomic.Int64
			closed := make(chan struct{}, 4)
			fixture := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.HasSuffix(r.URL.Path, "Sessions") {
					reads.Add(1)
					if r.Header.Get("X-Emby-Token") != "fixture-secret" {
						t.Error("wrong read credential")
					}
					json.NewEncoder(w).Encode([]any{map[string]any{"Id": "only-session", "UserId": service, "NowPlayingItem": map[string]string{"Id": "item", "Name": "Private authoritative title", "Type": "Movie"}, "PlayState": map[string]bool{"IsPaused": false}}})
					return
				}
				want := "/"
				if provider == "jellyfin" {
					want = "/socket"
				}
				if r.URL.Path != want || r.URL.Query().Get("api_key") != "fixture-secret" {
					t.Error("wrong socket endpoint")
					w.WriteHeader(403)
					return
				}
				c, err := websocket.Accept(w, r, nil)
				if err != nil {
					return
				}
				defer c.CloseNow()
				connections.Add(1)
				defer func() { closed <- struct{}{} }()
				var start map[string]string
				if err = wsjson.Read(r.Context(), c, &start); err != nil {
					return
				}
				if start["MessageType"] != "SessionsStart" || start["Data"] != "0,5000" {
					t.Error("wrong subscription")
				}
				for i := 0; i < 20; i++ {
					if err = wsjson.Write(r.Context(), c, map[string]any{"MessageType": "Sessions", "Data": []any{}, "Private": "never persist fixture-secret"}); err != nil {
						return
					}
				}
				var ignored any
				wsjson.Read(r.Context(), c, &ignored)
			}))
			defer fixture.Close()
			server := createManagedServer(t, a, token, provider, fixture.URL)
			service = seedService(t, s, server)
			if err := s.LinkServiceAccounts(t.Context(), owner.UUID, owner.UUID, []string{service}); err != nil {
				t.Fatal(err)
			}
			task := monitorSnapshot(t, a, token)["tasks"].([]any)[0].(map[string]any)
			body := monitorChange(owner.UUID, task, true)
			body["socket_enabled"] = true
			if w := apiRequest(a, "PUT", "/api/settings/activity-monitoring/"+task["server_id"].(string), token, body, nil); w.Code != 200 {
				t.Fatal(w.Code, w.Body.String())
			}
			// Configure before starting the worker: owner-added sources now poll
			// by default, and an in-flight claim correctly changes the revision.
			if err := a.StartScheduler(); err != nil {
				t.Fatal(err)
			}
			waitProviderSocket(t, func() bool { return a.queue.Stats().Accepted >= 20 && reads.Load() > 0 })
			if connections.Load() != 1 {
				t.Fatal("duplicate socket workers")
			}
			waitProviderSocket(t, func() bool {
				var count int
				s.reader.QueryRow("SELECT count(*) FROM media_activity_current").Scan(&count)
				return count == 1
			})
			a.StopScheduler()
			if err := a.WaitScheduler(t.Context()); err != nil {
				t.Fatal(err)
			}
			select {
			case <-closed:
			case <-time.After(2 * time.Second):
				t.Fatal("provider socket survived shutdown")
			}
			if err := a.queue.Shutdown(t.Context()); err != nil {
				t.Fatal(err)
			}
			var count int
			var payload string
			if err := s.reader.QueryRow("SELECT count(*),coalesce(group_concat(payload),'') FROM log_entries WHERE source=?", provider+".socket").Scan(&count, &payload); err != nil {
				t.Fatal(err)
			}
			if count != 20 || strings.Contains(payload, "private") || strings.Contains(payload, "fixture-secret") || strings.Contains(payload, "Data") {
				t.Fatal("unsafe or missing queued metadata")
			}
			var title string
			if err := s.reader.QueryRow("SELECT title FROM media_activity_history").Scan(&title); err != nil || title != "Private authoritative title" {
				t.Fatal("incremental frame replaced complete HTTP snapshot", err)
			}
		})
	}
}

func TestProviderSocketNudgeRechecksConsentAndQueueFailure(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	owner, _ := s.Authenticate(t.Context(), token)
	server := createManagedServer(t, a, token, "jellyfin", "http://example.invalid")
	configureTestMonitor(t, a, token, server, false)
	if targets, err := a.providerSocketTargets(t.Context()); err != nil || len(targets) != 0 {
		t.Fatal("socket default was enabled", err)
	}
	task := monitorSnapshot(t, a, token)["tasks"].([]any)[0].(map[string]any)
	body := monitorChange(owner.UUID, task, true)
	body["socket_enabled"] = true
	if w := apiRequest(a, "PUT", "/api/settings/activity-monitoring/"+task["server_id"].(string), token, body, nil); w.Code != 200 {
		t.Fatal(w.Code)
	}
	targets, err := a.providerSocketTargets(t.Context())
	if err != nil || len(targets) != 1 {
		t.Fatal(err)
	}
	w := &providerSocketWorker{target: targets[0]}
	w.dirty.Store(true)
	if err = a.nudgeProviderSocket(t.Context(), w); err != nil || w.dirty.Load() {
		t.Fatal("nudge not admitted", err)
	}
	w.lastNudge = time.Time{}
	w.dirty.Store(true)
	if err = s.write(t.Context(), func(tx *sql.Tx) error {
		_, e := tx.Exec("UPDATE activity_monitor_schedules SET socket_enabled=0 WHERE server_id=?", server)
		return e
	}); err != nil {
		t.Fatal(err)
	}
	if err = a.nudgeProviderSocket(t.Context(), w); err != nil || !w.dirty.Load() {
		t.Fatal("late dirty hint bypassed disabled consent", err)
	}
	activityExec(t, s, "UPDATE activity_monitor_schedules SET socket_enabled=1,socket_revision=socket_revision+1 WHERE server_id=?", server)
	if err = a.nudgeProviderSocket(t.Context(), w); err != nil || !w.dirty.Load() {
		t.Fatal("old socket bypassed renewed consent epoch", err)
	}
	if err = a.queue.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err = a.queue.Enqueue(LogEntry{Source: "jellyfin.socket", Type: "provider.activity.hint", Payload: json.RawMessage(`{}`)}); err == nil {
		t.Fatal("closed queue silently accepted frame")
	}
}

func TestProviderSocketWorkerReportsRejectedAdmission(t *testing.T) {
	a, _ := testApp(t)
	fixture := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		var start any
		if wsjson.Read(r.Context(), c, &start) != nil {
			return
		}
		wsjson.Write(r.Context(), c, map[string]any{"MessageType": "Sessions", "Data": []any{}})
		var ignored any
		wsjson.Read(r.Context(), c, &ignored)
	}))
	defer fixture.Close()
	if err := a.queue.Shutdown(t.Context()); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	w := &providerSocketWorker{done: make(chan struct{}), state: "connecting"}
	go a.runProviderSocket(ctx, w, ManagedServer{ID: 1, Type: "jellyfin", URL: fixture.URL, apiKey: "private-key"})
	waitProviderSocket(t, func() bool { w.mu.Lock(); defer w.mu.Unlock(); return w.code == "QUEUE_REJECTED" })
	cancel()
	select {
	case <-w.done:
	case <-time.After(2 * time.Second):
		t.Fatal("worker did not stop")
	}
	if a.queue.Stats().Accepted != 0 || a.queue.Stats().Rejected == 0 {
		t.Fatal("rejected metadata reported as accepted")
	}
}
