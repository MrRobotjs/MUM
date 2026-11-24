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

func TestHistorySignalCommitScopeAndRollback(t *testing.T) {
	f := activityReadFixture(t)
	signal := func(all bool) [32]byte {
		t.Helper()
		v, err := f.store.historySignal(t.Context(), f.user, f.token, all)
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	own, all := signal(false), signal(true)
	activityExec(t, f.store, "UPDATE media_servers SET server_nickname='First history source' WHERE id=?", f.server)
	other := seedServer(t, f.store)
	activityExec(t, f.store, `INSERT INTO history_imports(server_id,entry_key,account_id,viewed_at,imported_at) VALUES(?,'other','other','2026','2026')`, other)
	if signal(false) != own || signal(true) == all {
		t.Fatal("unrelated history leaked into own scope or admin missed it")
	}
	activityExec(t, f.store, `INSERT INTO media_activity_history(server_id,external_session_id,service_uuid,item_id,media_type,title,first_seen_at,last_seen_at,paused) VALUES(?,'unowned',?,'item','movie','Title','2026','2026',0)`, f.server, f.service)
	if signal(false) != own {
		t.Fatal("unowned history signaled to an ordinary user")
	}
	err := f.store.write(t.Context(), func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(context.Background(), `INSERT INTO media_activity_history(server_id,external_session_id,service_uuid,owner_uuid,item_id,media_type,title,first_seen_at,last_seen_at,paused) VALUES(?,'rollback',?,?,'item','movie','Title','2026','2026',0)`, f.server, f.service, f.user); err != nil {
			return err
		}
		return ErrConflict
	})
	if !errors.Is(err, ErrConflict) || signal(false) != own {
		t.Fatal("rolled-back change invalidated history", err)
	}
	activityExec(t, f.store, `INSERT INTO media_activity_history(server_id,external_session_id,service_uuid,owner_uuid,item_id,media_type,title,first_seen_at,last_seen_at,paused) VALUES(?,'own',?,?,'item','movie','Title','2026','2026',0)`, f.server, f.service, f.user)
	if signal(false) == own {
		t.Fatal("own committed history was not signaled")
	}
	own = signal(false)
	activityExec(t, f.store, `UPDATE media_activity_history SET paused=1 WHERE external_session_id='own'`)
	if signal(false) == own {
		t.Fatal("history update was not signaled")
	}
	own = signal(false)
	activityExec(t, f.store, `DELETE FROM media_activity_history WHERE external_session_id='own'`)
	if signal(false) == own {
		t.Fatal("history deletion was not signaled")
	}
	own = signal(false)
	activityExec(t, f.store, `INSERT INTO history_imports(server_id,entry_key,account_id,viewed_at,imported_at) SELECT server_id,'own-import',external_user_id,'2026','2026' FROM service_accounts WHERE uuid=?`, f.service)
	if signal(false) == own {
		t.Fatal("owned import was not signaled")
	}
	own = signal(false)
	activityExec(t, f.store, `UPDATE history_imports SET title='changed' WHERE entry_key='own-import'`)
	if signal(false) == own {
		t.Fatal("import update was not signaled")
	}
	own = signal(false)
	activityExec(t, f.store, `DELETE FROM history_imports WHERE entry_key='own-import'`)
	if signal(false) == own {
		t.Fatal("import deletion was not signaled")
	}
}

func TestHistoryRealtimeSocketScopeAndRevocation(t *testing.T) {
	f := activityReadFixture(t)
	activityExec(t, f.store, "DELETE FROM admin_privileges WHERE user_uuid=?", f.user)
	server := httptest.NewServer(f.app)
	defer server.Close()
	c, ctx := dialClient(t, server.URL, f.token)
	defer c.CloseNow()
	channel := "history." + f.user + ".own"
	if err := wsjson.Write(ctx, c, socketCommand{Type: "subscribe", Channels: []string{channel, "history." + f.user + ".all", "history.other.own"}}); err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := wsjson.Read(ctx, c, &m); err != nil || len(m["rejected"].([]any)) != 2 {
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
		if event["type"] != "HistoryInvalidated" || event["channel"] != channel || len(payload) != 2 || payload["actor_uuid"] != f.user || payload["scope"] != "own" {
			t.Fatal("unexpected history hint", m)
		}
	}
	read()
	activityExec(t, f.store, `INSERT INTO media_activity_history(server_id,external_session_id,service_uuid,owner_uuid,item_id,media_type,title,first_seen_at,last_seen_at,paused) VALUES(?,'socket',?,?,'item','movie','private title','2026','2026',0)`, f.server, f.service, f.user)
	read()
	activityExec(t, f.store, "DELETE FROM app_sessions WHERE user_uuid=?", f.user)
	deadline, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	if err := wsjson.Read(deadline, c, &m); err == nil {
		t.Fatal("revoked session received history")
	}
}
