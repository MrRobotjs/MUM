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

func TestNotificationSignalsCommitRollbackAndRecipientIsolation(t *testing.T) {
	a, s, owner, delegate, user := roleReadFixture(t)
	principal, _ := s.Authenticate(t.Context(), owner)
	server := seedServer(t, s)
	before, err := s.notificationSignal(t.Context(), principal.UUID)
	if err != nil {
		t.Fatal(err)
	}
	otherBefore, err := s.notificationSignal(t.Context(), user)
	if err != nil {
		t.Fatal(err)
	}
	private := noticeFixture(t, s, server, user)
	after, _ := s.notificationSignal(t.Context(), principal.UUID)
	otherAfter, _ := s.notificationSignal(t.Context(), user)
	if after != before || otherAfter.private <= otherBefore.private {
		t.Fatal("private change crossed recipient boundary")
	}
	// A reader must not observe uncommitted counters, and rollback must erase them.
	err = s.write(t.Context(), func(tx *sql.Tx) error {
		if _, err := tx.Exec("UPDATE admin_notifications SET resolved=1 WHERE id=?", private); err != nil {
			return err
		}
		seen, err := s.notificationSignal(t.Context(), user)
		if err != nil {
			return err
		}
		if seen != otherAfter {
			t.Fatal("uncommitted invalidation exposed")
		}
		return ErrConflict
	})
	if !errors.Is(err, ErrConflict) {
		t.Fatal(err)
	}
	rolled, _ := s.notificationSignal(t.Context(), user)
	if rolled != otherAfter {
		t.Fatal("rolled-back signal survived")
	}
	broadcast := noticeFixture(t, s, server, "")
	for _, actor := range []string{principal.UUID, user} {
		sig, _ := s.notificationSignal(t.Context(), actor)
		if sig.broadcast <= before.broadcast {
			t.Fatal("missing broadcast signal")
		}
	}
	preOwner, _ := s.notificationSignal(t.Context(), principal.UUID)
	preOther, _ := s.notificationSignal(t.Context(), user)
	frozen := inboxSnapshot(t, a, delegate)
	if w := apiRequest(a, "POST", "/api/notifications/state", delegate, inboxBody(frozen, "read", broadcast), nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	postOwner, _ := s.notificationSignal(t.Context(), principal.UUID)
	postOther, _ := s.notificationSignal(t.Context(), user)
	if postOwner != preOwner || postOther.inbox <= preOther.inbox {
		t.Fatal("receipt invalidation crossed inbox boundary")
	}
	if _, err = s.writer.Exec("UPDATE admin_notifications SET recipient_uuid=? WHERE id=?", principal.UUID, private); err != nil {
		t.Fatal(err)
	}
	newOwner, _ := s.notificationSignal(t.Context(), principal.UUID)
	oldRecipient, _ := s.notificationSignal(t.Context(), user)
	if newOwner.private <= postOwner.private || oldRecipient.private <= postOther.private {
		t.Fatal("recipient move failed to invalidate both sides")
	}
	if _, err = s.writer.Exec("DELETE FROM admin_notifications WHERE id=?", private); err != nil {
		t.Fatal(err)
	}
	deleted, _ := s.notificationSignal(t.Context(), principal.UUID)
	if deleted.private <= newOwner.private {
		t.Fatal("delete not signaled")
	}
}

func TestNotificationRealtimeSubscriptionDeliveryAndRevocation(t *testing.T) {
	a, s, owner, delegate, user := roleReadFixture(t)
	p, _ := s.Authenticate(t.Context(), owner)
	for _, tc := range []struct {
		token, channel string
		allowed        bool
	}{
		{owner, "notifications." + p.UUID, true}, {owner, "notifications." + user, false}, {delegate, "notifications." + user, true}, {delegate, "notifications." + p.UUID, false},
	} {
		principal, err := s.Authenticate(t.Context(), tc.token)
		if err != nil || a.hub.canSubscribe(t.Context(), principal, tc.channel) != tc.allowed {
			t.Fatal("incorrect notification scope", err)
		}
	}
	server := httptest.NewServer(a)
	defer server.Close()
	c, ctx := dialClient(t, server.URL, owner)
	defer c.CloseNow()
	channel := "notifications." + p.UUID
	if err := wsjson.Write(ctx, c, socketCommand{Type: "subscribe", Channels: []string{channel}}); err != nil {
		t.Fatal(err)
	}
	var message map[string]any
	if err := wsjson.Read(ctx, c, &message); err != nil || message["type"] != "subscriptions" {
		t.Fatal(message, err)
	}
	read := func() {
		t.Helper()
		deadline, cancel := context.WithTimeout(ctx, 3*time.Second)
		defer cancel()
		if err := wsjson.Read(deadline, c, &message); err != nil {
			t.Fatal(err)
		}
		event, ok := message["event"].(map[string]any)
		if !ok || event["channel"] != channel || event["type"] != "NotificationInvalidated" {
			t.Fatal(message)
		}
		payload := event["payload"].(map[string]any)
		if len(payload) != 1 || payload["actor_uuid"] != p.UUID {
			t.Fatal("notification payload exposed extra data", payload)
		}
	}
	read() // Initial committed-state hint closes the fetch/subscribe race.
	media := seedServer(t, s)
	noticeFixture(t, s, media, "")
	read()
	if _, err := s.writer.Exec("DELETE FROM app_sessions WHERE user_uuid=?", p.UUID); err != nil {
		t.Fatal(err)
	}
	deadline, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	if err := wsjson.Read(deadline, c, &message); err == nil {
		t.Fatal("revoked owner received notification")
	}
}

func TestNotificationRealtimeCoalescesAndRejectsStaleSubscription(t *testing.T) {
	a, s, owner, _, _ := roleReadFixture(t)
	p, _ := s.Authenticate(t.Context(), owner)
	channel := "notifications." + p.UUID
	c := &liveClient{owner: p.UUID, token: owner, channels: map[string]bool{channel: true}, send: make(chan any, 64), notificationGeneration: 1}
	var last notificationSignal
	var generation uint64
	if !a.hub.notificationUpdate(t.Context(), c, &last, &generation) || len(c.send) != 1 {
		t.Fatal("initial invalidation missing")
	}
	<-c.send
	if !a.hub.notificationUpdate(t.Context(), c, &last, &generation) || len(c.send) != 0 {
		t.Fatal("unchanged state was not coalesced")
	}
	delete(c.channels, channel)
	c.notificationGeneration++
	if !a.hub.notificationUpdate(t.Context(), c, &last, &generation) || len(c.send) != 0 {
		t.Fatal("unsubscribed delivery")
	}
	c.channels[channel] = true
	c.notificationGeneration++
	if !a.hub.notificationUpdate(t.Context(), c, &last, &generation) || len(c.send) != 1 {
		t.Fatal("resubscription did not refresh")
	}
	<-c.send
	if _, err := s.writer.Exec("DELETE FROM app_sessions WHERE user_uuid=?", p.UUID); err != nil {
		t.Fatal(err)
	}
	if a.hub.notificationUpdate(t.Context(), c, &last, &generation) {
		t.Fatal("revoked session remained subscribed")
	}
}
