package main

import (
	"database/sql"
	"fmt"
	"strconv"
	"strings"
	"testing"
	"time"
)

func seedSummaryHistory(t *testing.T, f activityViewFixture) {
	t.Helper()
	err := f.store.write(t.Context(), func(tx *sql.Tx) error {
		for i := 0; i < 127; i++ {
			var owner any = f.user
			if i >= 120 {
				owner = nil
			}
			now := utcTimestamp(time.Now())
			_, err := tx.ExecContext(t.Context(), `INSERT INTO media_activity_history(server_id,external_session_id,service_uuid,owner_uuid,item_id,media_type,title,first_seen_at,last_seen_at,ended_at,end_reason,paused) VALUES(?,?,?,?,'fixture-item','Movie','Private history',?,?,?,'not_observed',0)`, f.server, fmt.Sprintf("summary-%d", i), f.service, owner, now, now, now)
			if err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
func summaryData(t *testing.T, f activityViewFixture, token, query string) map[string]any {
	t.Helper()
	w := apiRequest(f.app, "GET", "/api/activity/summary"+query, token, nil, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("cacheable summary")
	}
	return responseData(t, w)
}
func TestActivitySummaryCompleteScopeNotCursorPage(t *testing.T) {
	f := activityReadFixture(t)
	seedSummaryHistory(t, f)
	activityExec(t, f.store, "DELETE FROM admin_privileges WHERE user_uuid=?", f.user)
	own := summaryData(t, f, f.token, "")
	if own["scope"] != "own" || own["actor_uuid"] != f.user || own["recorded_observations"] != "121" || own["ended_observations"] != "120" || own["retained_current_observations"] != "1" || own["fresh_current_observations"] != "1" {
		t.Fatal(own)
	}
	all := summaryData(t, f, f.ownerToken, "?scope=all")
	if all["recorded_observations"] != "128" || all["ended_observations"] != "127" {
		t.Fatal(all)
	}
	page := responseData(t, apiRequest(f.app, "GET", "/api/activity/history", f.token, nil, nil))
	if len(page["items"].([]any)) != 100 || page["next_before"] == nil {
		t.Fatal("fixture did not exceed cursor page")
	}
	server := all["servers"].([]any)[0].(map[string]any)
	if server["recorded_observations"] != "128" || server["freshness"] != "fresh" {
		t.Fatal(server)
	}
	raw := apiRequest(f.app, "GET", "/api/activity/summary?scope=all", f.ownerToken, nil, nil).Body.String()
	for _, secret := range []string{"Private history", "service_uuid", "owner_uuid", "item_id", "claim_token", "api_key", "watched_duration"} {
		if strings.Contains(raw, secret) {
			t.Fatal("private or unsupported field", secret)
		}
	}
	if apiRequest(f.app, "GET", "/api/activity/summary?scope=all", f.token, nil, nil).Code != 403 {
		t.Fatal("ordinary all scope admitted")
	}
}
func TestActivitySummaryFrozenOwnershipAndDelegation(t *testing.T) {
	for _, mode := range []string{"transfer", "delegate", "unlink"} {
		t.Run(mode, func(t *testing.T) {
			f := activityReadFixture(t)
			seedSummaryHistory(t, f)
			owner, _ := f.store.Authenticate(t.Context(), f.ownerToken)
			switch mode {
			case "transfer":
				activityExec(t, f.store, "UPDATE service_links SET user_uuid=? WHERE service_uuid=?", owner.UUID, f.service)
			case "delegate":
				activityExec(t, f.store, "UPDATE service_links SET link_kind='delegate' WHERE service_uuid=?", f.service)
			case "unlink":
				activityExec(t, f.store, "DELETE FROM service_links WHERE service_uuid=?", f.service)
			}
			for _, token := range []string{f.token, f.ownerToken} {
				p := summaryData(t, f, token, "")
				if p["recorded_observations"] != "0" || p["fresh_current_observations"] != "0" {
					t.Fatal("historical attribution leaked", p)
				}
			}
			if p := summaryData(t, f, f.ownerToken, "?scope=all"); p["recorded_observations"] != "128" {
				t.Fatal("history lost", p)
			}
		})
	}
}
func TestActivitySummaryFreshnessAndCurrentSemantics(t *testing.T) {
	for _, mode := range []string{"stale", "failed", "disabled", "mapping", "expired", "inactive-service", "never"} {
		t.Run(mode, func(t *testing.T) {
			f := activityReadFixture(t)
			switch mode {
			case "stale":
				activityExec(t, f.store, "UPDATE media_activity_state SET observed_at=?", utcTimestamp(time.Now().Add(-70*time.Second)))
			case "failed":
				activityExec(t, f.store, "UPDATE media_activity_state SET last_result='failed'")
			case "disabled":
				activityExec(t, f.store, "UPDATE provider_settings SET enabled=0 WHERE provider_id='jellyfin'")
			case "mapping":
				activityExec(t, f.store, "UPDATE media_activity_state SET mapping_revision=mapping_revision+1")
			case "expired":
				activityExec(t, f.store, "UPDATE media_activity_state SET pending_until='2000-01-01T00:00:00Z'")
			case "inactive-service":
				activityExec(t, f.store, "UPDATE service_accounts SET is_active=0 WHERE uuid=?", f.service)
			case "never":
				activityExec(t, f.store, "DELETE FROM media_activity_current")
				activityExec(t, f.store, "DELETE FROM media_activity_history")
				activityExec(t, f.store, "UPDATE media_activity_state SET observed_at=NULL,last_result='never'")
			}
			all := summaryData(t, f, f.ownerToken, "?scope=all")
			if all["fresh_current_observations"] != "0" {
				t.Fatal("unfresh rows counted fresh", all)
			}
			if mode != "never" && all["retained_current_observations"] != "1" {
				t.Fatal("retained observation lost", all)
			}
			own := summaryData(t, f, f.token, "")
			if mode == "disabled" || mode == "mapping" || mode == "inactive-service" {
				if own["retained_current_observations"] != "0" {
					t.Fatal("invalidated own current counted", own)
				}
			}
		})
	}
}
func TestActivitySummaryStrictQueriesAndLiveSession(t *testing.T) {
	f := activityReadFixture(t)
	for _, query := range []string{"?before=1", "?before=", "?scope=all&scope=own", "?server=01", "?server=%zz", "?user_uuid=" + f.user, "?scope=other"} {
		w := apiRequest(f.app, "GET", "/api/activity/summary"+query, f.ownerToken, nil, nil)
		if w.Code != 400 {
			t.Fatal(query, w.Code, w.Body.String())
		}
	}
	if p := summaryData(t, f, f.token, "?server="+strconv.FormatInt(f.server+999, 10)); p["recorded_observations"] != "0" || len(p["servers"].([]any)) != 0 {
		t.Fatal(p)
	}
	activityExec(t, f.store, "DELETE FROM app_sessions WHERE user_uuid=?", f.user)
	if apiRequest(f.app, "GET", "/api/activity/summary", f.token, nil, nil).Code != 401 {
		t.Fatal("revoked session read summary")
	}
	if apiRequest(f.app, "GET", "/api/activity/summary", "", nil, nil).Code != 401 {
		t.Fatal("anonymous summary")
	}
}
