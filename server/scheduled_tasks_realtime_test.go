package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/coder/websocket/wsjson"
)

// A refresh tells subscribed administrators when it starts and when it has
// finished, with no task data in the event; other accounts cannot subscribe.
func TestScheduledTasksChannelAnnouncesRefreshStartAndFinish(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	owner, _ := s.Authenticate(t.Context(), token)
	hash, _ := hashPassword("a-strong-member-password")
	if _, err := s.CreateAccount(t.Context(), owner.UUID, "viewer", hash, false); err != nil {
		t.Fatal(err)
	}
	w := apiRequest(a, "POST", "/api/auth/login", "", map[string]any{"username": "viewer", "password": "a-strong-member-password"}, nil)
	viewer, err := s.Authenticate(t.Context(), responseData(t, w)["access_token"].(string))
	if err != nil {
		t.Fatal(err)
	}
	if !a.hub.canSubscribe(t.Context(), owner, scheduledTasksChannel) || a.hub.canSubscribe(t.Context(), viewer, scheduledTasksChannel) {
		t.Fatal("wrong scheduled tasks channel scope")
	}

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusServiceUnavailable) }))
	defer upstream.Close()
	id := createManagedServer(t, a, token, "jellyfin", upstream.URL)
	server := httptest.NewServer(a)
	defer server.Close()
	c, ctx := dialClient(t, server.URL, token)
	defer c.CloseNow()
	if err := wsjson.Write(ctx, c, socketCommand{Type: "subscribe", Channels: []string{scheduledTasksChannel}}); err != nil {
		t.Fatal(err)
	}
	var message map[string]any
	if err := wsjson.Read(ctx, c, &message); err != nil || message["type"] != "subscriptions" {
		t.Fatal(message, err)
	}
	activityExec(t, s, "UPDATE server_refresh_schedules SET next_run_at='2000-01-01T00:00:00Z' WHERE server_id=? AND scope='users'", id)
	if err := a.runOneServerRefreshScope(t.Context(), "users"); err != nil {
		t.Fatal(err)
	}
	for changes := 0; changes < 2; {
		deadline, cancel := context.WithTimeout(ctx, 3*time.Second)
		err := wsjson.Read(deadline, c, &message)
		cancel()
		if err != nil {
			t.Fatal("missing task event", err)
		}
		event, _ := message["event"].(map[string]any)
		if event["type"] == "ScheduledTaskProgress" {
			continue
		}
		changes++
		payload, _ := event["payload"].(map[string]any)
		if event["channel"] != scheduledTasksChannel || event["type"] != "ScheduledTasksChanged" || payload == nil || len(payload) != 0 {
			t.Fatal(message)
		}
	}
	var state string
	if err := s.reader.QueryRow("SELECT run_state FROM server_refresh_schedules WHERE server_id=? AND scope='users'", id).Scan(&state); err != nil || state == "running" {
		t.Fatal("the finish event came before the finish committed", state, err)
	}
}

// Progress events are limited to about one a second, except when the library
// or phase changes, and progress is forgotten when the refresh ends.
func TestRefreshProgressEventsAreThrottledAndCleared(t *testing.T) {
	a, _ := testApp(t)
	token, _ := bootstrapOwner(t, a)
	server := httptest.NewServer(a)
	defer server.Close()
	c, ctx := dialClient(t, server.URL, token)
	defer c.CloseNow()
	if err := wsjson.Write(ctx, c, socketCommand{Type: "subscribe", Channels: []string{scheduledTasksChannel}}); err != nil {
		t.Fatal(err)
	}
	var message map[string]any
	if err := wsjson.Read(ctx, c, &message); err != nil || message["type"] != "subscriptions" {
		t.Fatal(message, err)
	}
	claim := &serverRefreshClaim{Server: 9, Scope: "libraries"}
	a.setRefreshProgress(claim, refreshProgress{Library: "Movies", Phase: "items", Done: 200, Total: 1000})
	a.setRefreshProgress(claim, refreshProgress{Library: "Movies", Phase: "items", Done: 400, Total: 1000}) // within a second: not sent
	a.setRefreshProgress(claim, refreshProgress{Library: "Shows", Phase: "items", Done: 0, Total: 50})      // new library: sent
	for _, want := range []string{"Movies", "Shows"} {
		deadline, cancel := context.WithTimeout(ctx, 3*time.Second)
		err := wsjson.Read(deadline, c, &message)
		cancel()
		if err != nil {
			t.Fatal(err)
		}
		event, _ := message["event"].(map[string]any)
		payload, _ := event["payload"].(map[string]any)
		progress, _ := payload["progress"].(map[string]any)
		if event["type"] != "ScheduledTaskProgress" || payload["server_id"] != float64(9) || payload["scope"] != "libraries" || progress["library"] != want {
			t.Fatal(message)
		}
	}
	deadline, cancel := context.WithTimeout(ctx, 300*time.Millisecond)
	defer cancel()
	if err := wsjson.Read(deadline, c, &message); err == nil {
		t.Fatal("throttled progress was sent", message)
	}
	if p := a.currentRefreshProgress(9, "libraries"); p == nil || p.Library != "Shows" || p.Total != 50 {
		t.Fatal(p)
	}
	a.clearRefreshProgress(claim)
	if a.currentRefreshProgress(9, "libraries") != nil {
		t.Fatal("progress kept after the refresh ended")
	}
}
