package main

import (
	"context"
	"database/sql"
	"errors"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/coder/websocket/wsjson"
)

func TestActivitySignalsScopeRollbackAndOwnership(t *testing.T) {
	f := activityReadFixture(t)
	s := f.store
	signal := func(all bool) [32]byte {
		t.Helper()
		v, err := s.activitySignal(t.Context(), f.user, f.token, all)
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	activityExec(t, s, "UPDATE media_servers SET server_nickname='Original activity source' WHERE id=?", f.server)
	other := seedServer(t, s)
	own, all := signal(false), signal(true)
	activityExec(t, s, "UPDATE media_activity_state SET revision=revision+1 WHERE server_id=?", other)
	if signal(false) != own || signal(true) == all {
		t.Fatal("unrelated source invalidated own scope or missed administrator scope")
	}
	err := s.write(t.Context(), func(tx *sql.Tx) error {
		if _, err := tx.Exec("UPDATE media_activity_state SET revision=revision+1 WHERE server_id=?", f.server); err != nil {
			return err
		}
		if signal(false) != own {
			t.Fatal("uncommitted signal exposed")
		}
		return ErrConflict
	})
	if !errors.Is(err, ErrConflict) || signal(false) != own {
		t.Fatal("rollback changed signal", err)
	}
	activityExec(t, s, "UPDATE media_activity_state SET observed_at=? WHERE server_id=?", utcTimestamp(time.Now().Add(-70*time.Second)), f.server)
	stale := signal(false)
	if stale == own {
		t.Fatal("freshness transition not signaled")
	}
	activityExec(t, s, "UPDATE media_activity_state SET last_result='failed',revision=revision+1 WHERE server_id=?", f.server)
	failed := signal(false)
	if failed == stale {
		t.Fatal("failed observation not signaled")
	}
	activityExec(t, s, "DELETE FROM service_links WHERE service_uuid=?", f.service)
	if signal(false) == failed {
		t.Fatal("loss of primary ownership not signaled")
	}
	activityExec(t, s, "INSERT INTO service_links(user_uuid,service_uuid,link_kind,created_at) VALUES(?,?,'delegate',?)", f.user, f.service, utcTimestamp(time.Now()))
	delegateOnly := signal(false)
	activityExec(t, s, "UPDATE media_activity_state SET revision=revision+1 WHERE server_id=?", f.server)
	if signal(false) != delegateOnly {
		t.Fatal("delegate received owner activity signals")
	}
}

func TestActivityRealtimeCoalescesScopesAndRevokesAuthority(t *testing.T) {
	f := activityReadFixture(t)
	s := f.store
	activityExec(t, s, "DELETE FROM admin_privileges WHERE user_uuid=?", f.user)
	p, err := s.Authenticate(t.Context(), f.token)
	if err != nil {
		t.Fatal(err)
	}
	channel := "activity." + f.user + ".own"
	if !f.app.hub.canSubscribe(t.Context(), p, channel) || f.app.hub.canSubscribe(t.Context(), p, "activity."+f.user+".all") || f.app.hub.canSubscribe(t.Context(), p, "activity.other.own") {
		t.Fatal("activity scope escalation")
	}
	c := &liveClient{owner: f.user, token: f.token, channels: map[string]bool{channel: true}, send: make(chan any, 64), activityGeneration: 1}
	var cursor activityRealtimeCursor
	if !f.app.hub.activityUpdate(t.Context(), c, false, &cursor) || len(c.send) != 1 {
		t.Fatal("initial hint missing")
	}
	<-c.send
	if !f.app.hub.activityUpdate(t.Context(), c, false, &cursor) || len(c.send) != 0 {
		t.Fatal("unchanged signal not coalesced")
	}
	delete(c.channels, channel)
	if !f.app.hub.activityUpdate(t.Context(), c, false, &cursor) || cursor.seen {
		t.Fatal("unsubscribe retained cursor")
	}
	c.channels[channel] = true
	if !f.app.hub.activityUpdate(t.Context(), c, false, &cursor) || len(c.send) != 1 {
		t.Fatal("resubscription not refreshed")
	}
	<-c.send
	if _, err = s.writer.Exec("DELETE FROM app_sessions WHERE user_uuid=?", f.user); err != nil {
		t.Fatal(err)
	}
	if f.app.hub.activityUpdate(t.Context(), c, false, &cursor) {
		t.Fatal("revoked session polled activity")
	}
}

func TestActivityRealtimeSocketMinimalPayloadAndRevocation(t *testing.T) {
	f := activityReadFixture(t)
	activityExec(t, f.store, "DELETE FROM admin_privileges WHERE user_uuid=?", f.user)
	server := httptest.NewServer(f.app)
	defer server.Close()
	c, ctx := dialClient(t, server.URL, f.token)
	defer c.CloseNow()
	channel := "activity." + f.user + ".own"
	if err := wsjson.Write(ctx, c, socketCommand{Type: "subscribe", Channels: []string{channel, "activity." + f.user + ".all"}}); err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := wsjson.Read(ctx, c, &m); err != nil || len(m["rejected"].([]any)) != 1 {
		t.Fatal(m, err)
	}
	read := func() {
		t.Helper()
		deadline, cancel := context.WithTimeout(ctx, 3*time.Second)
		defer cancel()
		if err := wsjson.Read(deadline, c, &m); err != nil {
			t.Fatal(err)
		}
		event := m["event"].(map[string]any)
		payload := event["payload"].(map[string]any)
		if event["type"] != "ActivityInvalidated" || event["channel"] != channel || len(payload) != 2 || payload["actor_uuid"] != f.user || payload["scope"] != "own" {
			t.Fatal("private activity fields in hint", m)
		}
	}
	read()
	activityExec(t, f.store, "UPDATE media_activity_state SET revision=revision+1 WHERE server_id=?", f.server)
	read()
	activityExec(t, f.store, "DELETE FROM app_sessions WHERE user_uuid=?", f.user)
	deadline, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	if err := wsjson.Read(deadline, c, &m); err == nil {
		t.Fatal("revoked socket received activity")
	}
}
