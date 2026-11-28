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
	for range 2 {
		deadline, cancel := context.WithTimeout(ctx, 3*time.Second)
		err := wsjson.Read(deadline, c, &message)
		cancel()
		if err != nil {
			t.Fatal("missing task event", err)
		}
		event, _ := message["event"].(map[string]any)
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
