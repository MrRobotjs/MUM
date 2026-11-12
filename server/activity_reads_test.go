package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

type activityViewFixture struct {
	app                              *App
	store                            *Store
	ownerToken, token, user, service string
	server                           int64
}

func activityReadFixture(t *testing.T) activityViewFixture {
	t.Helper()
	a, s, ownerToken, token, user := roleReadFixture(t)
	owner, err := s.Authenticate(t.Context(), ownerToken)
	if err != nil {
		t.Fatal(err)
	}
	server := seedServer(t, s)
	service := seedService(t, s, server)
	if err := s.LinkServiceAccounts(t.Context(), owner.UUID, user, []string{service}); err != nil {
		t.Fatal(err)
	}
	claim, err := s.beginActivityRead(t.Context(), owner.UUID, ownerToken, server)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.applyActivitySnapshot(t.Context(), claim, activityForUser(t, service)); err != nil {
		t.Fatal(err)
	}
	return activityViewFixture{a, s, ownerToken, token, user, service, server}
}
func activityExec(t *testing.T, s *Store, query string, args ...any) {
	t.Helper()
	if _, err := s.writer.Exec(query, args...); err != nil {
		t.Fatal(err)
	}
}
func TestActivityReadsOwnScopePrivacyAndTransfer(t *testing.T) {
	f := activityReadFixture(t)
	activityExec(t, f.store, "DELETE FROM admin_privileges WHERE user_uuid=?", f.user)
	for _, endpoint := range []string{"current", "history"} {
		path := "/api/activity/" + endpoint
		w := apiRequest(f.app, "GET", path, f.token, nil, nil)
		if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal(w.Code, w.Body.String())
		}
		data := responseData(t, w)
		items := data["items"].([]any)
		if len(items) != 1 || len(data["servers"].([]any)) != 1 || data["scope"] != "own" || data["actor_uuid"] != f.user {
			t.Fatal(data)
		}
		for _, secret := range []string{"owner_uuid", "external_session_id", "pending_token", "mapping_revision", "fixture-secret", "password_hash", "Client", "RemoteEndPoint"} {
			if strings.Contains(w.Body.String(), secret) {
				t.Fatal("leaked", secret)
			}
		}
		if apiRequest(f.app, "GET", path+"?scope=all", f.token, nil, nil).Code != 403 {
			t.Fatal("ordinary account read all")
		}
		if apiRequest(f.app, "GET", path, "", nil, nil).Code != 401 {
			t.Fatal("anonymous read")
		}
		w = apiRequest(f.app, "GET", path+"?scope=all", f.ownerToken, nil, nil)
		if w.Code != 200 || len(responseData(t, w)["items"].([]any)) != 1 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	// Transfer the current primary link without rewriting frozen attribution.
	owner, _ := f.store.Authenticate(t.Context(), f.ownerToken)
	activityExec(t, f.store, "UPDATE service_links SET user_uuid=? WHERE service_uuid=? AND link_kind='owner'", owner.UUID, f.service)
	for _, token := range []string{f.token, f.ownerToken} {
		for _, endpoint := range []string{"current", "history"} {
			w := apiRequest(f.app, "GET", "/api/activity/"+endpoint, token, nil, nil)
			if w.Code != 200 || len(responseData(t, w)["items"].([]any)) != 0 {
				t.Fatal("transfer disclosed frozen activity", w.Code, w.Body.String())
			}
		}
	}
	w := apiRequest(f.app, "GET", "/api/activity/history?scope=all", f.ownerToken, nil, nil)
	if w.Code != 200 || responseData(t, w)["items"].([]any)[0].(map[string]any)["owner_uuid"] != f.user {
		t.Fatal("history attribution rewritten", w.Body.String())
	}
}
func TestActivityReadsDelegateAndUnlinkedDoNotGainHistory(t *testing.T) {
	f := activityReadFixture(t)
	activityExec(t, f.store, "UPDATE service_links SET link_kind='delegate' WHERE service_uuid=?", f.service)
	for _, endpoint := range []string{"current", "history"} {
		w := apiRequest(f.app, "GET", "/api/activity/"+endpoint, f.token, nil, nil)
		data := responseData(t, w)
		if w.Code != 200 || len(data["items"].([]any)) != 0 || len(data["servers"].([]any)) != 0 {
			t.Fatal(w.Code, data)
		}
	}
}
func TestActivityReadFreshness(t *testing.T) {
	for _, mode := range []string{"fresh", "stale", "failed", "never", "disabled", "provider-disabled", "mapping", "server", "pending", "expired", "null-ticks", "bad-time", "future-time"} {
		t.Run(mode, func(t *testing.T) {
			f := activityReadFixture(t)
			expected := "fresh"
			switch mode {
			case "stale":
				activityExec(t, f.store, "UPDATE media_activity_state SET observed_at=?", utcTimestamp(time.Now().Add(-65*time.Second)))
				expected = "stale"
			case "failed":
				activityExec(t, f.store, "UPDATE media_activity_state SET last_result='failed'")
				expected = "failed"
			case "never":
				activityExec(t, f.store, "UPDATE media_activity_state SET observed_at=NULL,last_result='never'")
				expected = "never"
			case "disabled":
				activityExec(t, f.store, "UPDATE media_servers SET is_active=0")
				expected = "disabled"
			case "provider-disabled":
				activityExec(t, f.store, "UPDATE provider_settings SET enabled=0 WHERE provider_id='jellyfin'")
				expected = "disabled"
			case "mapping":
				activityExec(t, f.store, "UPDATE media_activity_state SET mapping_revision=mapping_revision+1")
				expected = "invalidated"
			case "server":
				activityExec(t, f.store, "UPDATE media_servers SET revision=revision+1")
				expected = "invalidated"
			case "pending":
				activityExec(t, f.store, "UPDATE media_activity_state SET pending_until=?", utcTimestamp(time.Now().Add(time.Second*15)))
			case "expired":
				activityExec(t, f.store, "UPDATE media_activity_state SET pending_until='2000-01-01T00:00:00Z'")
				expected = "stale"
			case "null-ticks":
				activityExec(t, f.store, "UPDATE media_activity_history SET position_ticks=NULL,duration_ticks=NULL")
			case "bad-time":
				activityExec(t, f.store, "UPDATE media_activity_state SET observed_at='invalid'")
			case "future-time":
				activityExec(t, f.store, "UPDATE media_activity_state SET observed_at=?", utcTimestamp(time.Now().Add(time.Hour)))
			}
			w := apiRequest(f.app, "GET", "/api/activity/current?scope=all", f.ownerToken, nil, nil)
			if mode == "bad-time" || mode == "future-time" {
				if w.Code != 409 {
					t.Fatal(w.Code, w.Body.String())
				}
				return
			}
			if w.Code != 200 {
				t.Fatal(w.Code, w.Body.String())
			}
			data := responseData(t, w)
			status := data["servers"].([]any)[0].(map[string]any)
			if status["freshness"] != expected {
				t.Fatal(status)
			}
			if mode == "pending" && status["pending"] != "running" || mode == "expired" && status["pending"] != "expired" {
				t.Fatal(status)
			}
			if mode == "null-ticks" {
				row := data["items"].([]any)[0].(map[string]any)
				if row["position_ticks"] != nil || row["duration_ticks"] != nil {
					t.Fatal(row)
				}
			}
			if mode == "mapping" || mode == "server" || mode == "disabled" || mode == "provider-disabled" {
				own := apiRequest(f.app, "GET", "/api/activity/current", f.token, nil, nil)
				if own.Code != 200 || len(responseData(t, own)["items"].([]any)) != 0 {
					t.Fatal("invalid own current disclosed", own.Body.String())
				}
			}
		})
	}
}
func TestActivityDeliveryRechecksLiveAuthorityAndRevisions(t *testing.T) {
	for _, mode := range []string{"logout", "inactive", "role", "mapping", "server", "new-observation", "new-owned-server", "unchanged"} {
		t.Run(mode, func(t *testing.T) {
			f := activityReadFixture(t)
			q := activityReadQuery{All: mode == "role"}
			tx, err := f.store.beginActivityView(t.Context(), f.user, f.token, q.All)
			if err != nil {
				t.Fatal(err)
			}
			_, fences, err := readActivityStatuses(t.Context(), tx, f.user, q, time.Now())
			if err != nil {
				t.Fatal(err)
			}
			if err := tx.Commit(); err != nil {
				t.Fatal(err)
			}
			switch mode {
			case "logout":
				activityExec(t, f.store, "DELETE FROM app_sessions WHERE user_uuid=?", f.user)
			case "inactive":
				activityExec(t, f.store, "UPDATE user_accounts SET is_active=0 WHERE uuid=?", f.user)
			case "role":
				activityExec(t, f.store, "DELETE FROM admin_privileges WHERE user_uuid=?", f.user)
			case "mapping":
				activityExec(t, f.store, "DELETE FROM service_links WHERE service_uuid=?", f.service)
			case "server":
				activityExec(t, f.store, "UPDATE media_servers SET revision=revision+1 WHERE id=?", f.server)
			case "new-observation":
				activityExec(t, f.store, "UPDATE media_activity_state SET revision=revision+1")
			case "new-owned-server":
				activityExec(t, f.store, "UPDATE media_servers SET server_nickname='first-activity-server' WHERE id=?", f.server)
				server := seedServer(t, f.store)
				service := seedService(t, f.store, server)
				activityExec(t, f.store, "INSERT INTO service_links(user_uuid,service_uuid,link_kind,created_at) VALUES(?,?,'owner',?)", f.user, service, utcTimestamp(time.Now()))
			}
			err = f.store.checkActivityDelivery(t.Context(), f.user, f.token, q, fences)
			if mode == "unchanged" {
				if err != nil {
					t.Fatal(err)
				}
			} else if err == nil {
				t.Fatal("stale delivery accepted")
			}
		})
	}
}
func TestActivityHistoryPaginationAndStrictQueries(t *testing.T) {
	f := activityReadFixture(t)
	// Ended observations remain history but never become current rows.
	err := f.store.write(t.Context(), func(tx *sql.Tx) error {
		for i := 0; i < 102; i++ {
			_, err := tx.ExecContext(t.Context(), `INSERT INTO media_activity_history(server_id,external_session_id,service_uuid,owner_uuid,item_id,media_type,title,first_seen_at,last_seen_at,ended_at,end_reason,paused,position_ticks) VALUES(?,?,?,?,'item','Movie','Fixture title',?,?,?,'not_observed',0,9007199254740993)`, f.server, fmt.Sprintf("ended-%d", i), f.service, f.user, utcTimestamp(time.Now()), utcTimestamp(time.Now()), utcTimestamp(time.Now()))
			if err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	w := apiRequest(f.app, "GET", "/api/activity/history", f.token, nil, nil)
	data := responseData(t, w)
	items := data["items"].([]any)
	if w.Code != 200 || len(items) != 100 || data["next_before"] == nil || items[0].(map[string]any)["position_ticks"] != "9007199254740993" {
		t.Fatal(w.Code, data)
	}
	next := data["next_before"].(string)
	w = apiRequest(f.app, "GET", "/api/activity/history?before="+next, f.token, nil, nil)
	second := responseData(t, w)
	if w.Code != 200 || len(second["items"].([]any)) != 3 || second["next_before"] != nil {
		t.Fatal(w.Code, second)
	}
	w = apiRequest(f.app, "GET", "/api/activity/current", f.token, nil, nil)
	if len(responseData(t, w)["items"].([]any)) != 1 {
		t.Fatal("ended history shown current")
	}
	for _, query := range []string{"?scope=other", "?scope=own&scope=all", "?user_uuid=" + f.user, "?server=01", "?before=0", "?before=-1", "?before=9223372036854775808", "?before=1&before=2", "?limit=1000", "?server=%zz", "?scope=all;user=other"} {
		w := apiRequest(f.app, "GET", "/api/activity/history"+query, f.ownerToken, nil, nil)
		if w.Code != 400 {
			t.Fatal(query, w.Code, w.Body.String())
		}
	}
	w = apiRequest(f.app, "GET", "/api/activity/history?server=9223372036854775807", f.token, nil, nil)
	if w.Code != 200 || len(responseData(t, w)["items"].([]any)) != 0 {
		t.Fatal(w.Code, w.Body.String())
	}
	// A cosmetic administrator role must not authorize all-scope reads.
	activityExec(t, f.store, "DELETE FROM admin_privileges WHERE user_uuid=?", f.user)
	activityExec(t, f.store, "INSERT INTO admin_privileges(user_uuid,role_id) VALUES(?,'low')", f.user)
	if apiRequest(f.app, "GET", "/api/activity/history?scope=all", f.token, nil, nil).Code != 403 {
		t.Fatal("role name elevated scope")
	}
	var body map[string]any
	if json.Unmarshal(w.Body.Bytes(), &body) != nil {
		t.Fatal("invalid JSON")
	}
	if err := f.store.checkActivityDelivery(t.Context(), f.user, "revoked", activityReadQuery{}, nil); !errors.Is(err, ErrForbidden) {
		t.Fatal(err)
	}
}
