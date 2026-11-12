package main

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

func seedWatch(t *testing.T, f activityViewFixture, session, item, kind, title string, start time.Time, minutes int) {
	t.Helper()
	end := start.Add(time.Duration(minutes) * time.Minute)
	activityExec(t, f.store, `INSERT INTO media_activity_history(server_id,external_session_id,service_uuid,owner_uuid,item_id,media_type,title,first_seen_at,last_seen_at,ended_at,end_reason,paused) VALUES(?,?,?,?,?,?,?,?,?,?,'not_observed',0)`,
		f.server, session, f.service, f.user, item, kind, title, utcTimestamp(start), utcTimestamp(end), utcTimestamp(end))
}

func TestActivityStatisticsAggregatesRetainedHistoryForAdministrators(t *testing.T) {
	f := activityReadFixture(t)
	now := time.Now().UTC().Truncate(time.Hour)
	seedWatch(t, f, "a", "m1", "Movie", "Popular Movie", now.Add(-2*time.Hour), 60)
	seedWatch(t, f, "b", "m1", "Movie", "Popular Movie", now.Add(-26*time.Hour), 30)
	seedWatch(t, f, "c", "m2", "movie", "Other Movie", now.Add(-3*time.Hour), 90)
	seedWatch(t, f, "d", "e1", "Episode", "Episode Title", now.Add(-4*time.Hour), 45)
	seedWatch(t, f, "e", "m3", "Movie", "Too Old", now.AddDate(0, 0, -20), 120)
	w := apiRequest(f.app, "GET", "/api/activity/statistics?days=7", f.ownerToken, nil, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var body struct {
		Data struct {
			Movies    []watchTitle `json:"top_movies"`
			Shows     []watchTitle `json:"top_shows"`
			Platforms []any        `json:"top_platforms"`
			Totals    map[string]any
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	totals := body.Data.Totals
	// The fixture's own observation adds one retained row in the window.
	if totals["total_plays"] != float64(5) || totals["unique_users"] != float64(1) || totals["peak_day_streams"] == float64(0) {
		t.Fatal(totals)
	}
	// The fixture observation adds a third, zero-length movie ranked last.
	if len(body.Data.Movies) != 3 || body.Data.Movies[2].Duration != "0m" || body.Data.Movies[0].Title != "Popular Movie" || body.Data.Movies[0].Plays != 2 || body.Data.Movies[0].Duration != "1h 30m" || body.Data.Movies[1].Title != "Other Movie" {
		t.Fatal(body.Data.Movies)
	}
	// Episode names are not show names, and devices are not recorded.
	if len(body.Data.Shows) != 0 || len(body.Data.Platforms) != 0 || strings.Contains(w.Body.String(), "Episode Title") || strings.Contains(w.Body.String(), "Too Old") {
		t.Fatal(w.Body.String())
	}
	for _, bad := range []string{"?days=0", "?days=91", "?days=x", "?other=1"} {
		if w := apiRequest(f.app, "GET", "/api/activity/statistics"+bad, f.ownerToken, nil, nil); w.Code != 400 {
			t.Fatal(bad, w.Code)
		}
	}
	activityExec(t, f.store, "DELETE FROM admin_privileges WHERE user_uuid=?", f.user)
	if w := apiRequest(f.app, "GET", "/api/activity/statistics", f.token, nil, nil); w.Code != 403 {
		t.Fatal("non-administrator read statistics", w.Code)
	}
}

func TestRecentAuditEventsExposeOnlyFixedMessages(t *testing.T) {
	f := activityReadFixture(t)
	for i, action := range []string{"server.save", "service.remote_access.disable", "provisioning.cancel", "custom.unknown"} {
		activityExec(t, f.store, "INSERT INTO audit_events(actor_uuid,action,details,occurred_at) VALUES(NULL,?,?,?)", action, fmt.Sprintf(`{"reason":"private reason %d","password":"secret"}`, i), utcTimestamp(time.Now()))
	}
	w := apiRequest(f.app, "GET", "/api/audit-events?limit=4", f.ownerToken, nil, nil)
	if w.Code != 200 || strings.Contains(w.Body.String(), "private reason") || strings.Contains(w.Body.String(), "secret") {
		t.Fatal(w.Code, w.Body.String())
	}
	var body struct {
		Data []struct {
			Type    string `json:"event_type"`
			Message string `json:"message"`
		} `json:"data"`
	}
	json.Unmarshal(w.Body.Bytes(), &body)
	want := []string{"An administrative action was recorded", "A provisioning job changed", "Remote access was disabled", "A media server was saved"}
	if len(body.Data) != 4 {
		t.Fatal(body.Data)
	}
	for i, item := range body.Data {
		if item.Message != want[i] {
			t.Fatal(i, item)
		}
	}
	for _, bad := range []string{"?limit=0", "?limit=51", "?page=1"} {
		if w := apiRequest(f.app, "GET", "/api/audit-events"+bad, f.ownerToken, nil, nil); w.Code != 400 {
			t.Fatal(bad, w.Code)
		}
	}
	activityExec(t, f.store, "DELETE FROM admin_privileges WHERE user_uuid=?", f.user)
	if w := apiRequest(f.app, "GET", "/api/audit-events", f.token, nil, nil); w.Code != 403 {
		t.Fatal("non-administrator read audit events", w.Code)
	}
}

func TestActivityDisplayNamesOnlyInAdministratorScope(t *testing.T) {
	f := activityReadFixture(t)
	activityExec(t, f.store, "UPDATE service_accounts SET external_username='remote-viewer' WHERE uuid=?", f.service)
	all := apiRequest(f.app, "GET", "/api/activity/current?scope=all", f.ownerToken, nil, nil)
	if all.Code != 200 || !strings.Contains(all.Body.String(), `"owner_name":"role-reader"`) || !strings.Contains(all.Body.String(), `"service_username":"remote-viewer"`) {
		t.Fatal(all.Code, all.Body.String())
	}
	own := apiRequest(f.app, "GET", "/api/activity/current", f.token, nil, nil)
	if own.Code != 200 || strings.Contains(own.Body.String(), "owner_name") || strings.Contains(own.Body.String(), "service_username") {
		t.Fatal(own.Code, own.Body.String())
	}
}
