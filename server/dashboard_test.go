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
