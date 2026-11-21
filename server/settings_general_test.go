package main

import (
	"fmt"
	"strings"
	"testing"
)

func TestGeneralSettingsSaveValidatesAuditsAndPersists(t *testing.T) {
	a, s, ownerToken, token, user := roleReadFixture(t)
	activityExec(t, s, "INSERT INTO settings(key,value) VALUES('APP_LOCAL_URL','http://192.168.1.10:5699') ON CONFLICT(key) DO UPDATE SET value=excluded.value")
	body := map[string]any{"app_name": "Family Media", "public_address": "https://media.example.test/", "session_idle_days": 5, "session_max_days": 21}
	w := apiRequest(a, "PATCH", "/api/settings/general", ownerToken, body, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	// A trailing slash is dropped, so links never get a double slash.
	if got := responseData(t, w); got["app_name"] != "Family Media" || got["public_address"] != "https://media.example.test" {
		t.Fatal("saved settings", got)
	}
	got := responseData(t, apiRequest(a, "GET", "/api/settings/general", ownerToken, nil, nil))
	if got["app_name"] != "Family Media" || got["public_address"] != "https://media.example.test" ||
		got["session_idle_days"] != float64(5) || got["session_max_days"] != float64(21) {
		t.Fatal("settings not persisted", got)
	}
	if status, _ := got["sessions"].(map[string]any); status == nil || status["https_detected"] != false || status["secure_cookies_forced"] != false {
		t.Fatal("cookie security status", got)
	}
	if _, listed := got["app_local_url"]; listed {
		t.Fatal("the removed local address is still reported", got)
	}
	var locals int
	s.reader.QueryRow("SELECT count(*) FROM settings WHERE key='APP_LOCAL_URL'").Scan(&locals)
	if locals != 0 {
		t.Fatal("the unused local address was kept")
	}
	var audits int
	s.reader.QueryRow("SELECT count(*) FROM audit_events WHERE action='settings.general.save'").Scan(&audits)
	if audits != 1 {
		t.Fatal("save not audited", audits)
	}
	for name, bad := range map[string]map[string]any{
		"empty name":          {"app_name": " ", "public_address": "", "session_idle_days": 7, "session_max_days": 30},
		"long name":           {"app_name": strings.Repeat("x", 101), "public_address": "", "session_idle_days": 7, "session_max_days": 30},
		"not http":            {"app_name": "MUM", "public_address": "ftp://example.test", "session_idle_days": 7, "session_max_days": 30},
		"not an address":      {"app_name": "MUM", "public_address": "mum.example.test", "session_idle_days": 7, "session_max_days": 30},
		"with credentials":    {"app_name": "MUM", "public_address": "https://user:pass@example.test", "session_idle_days": 7, "session_max_days": 30},
		"with a path":         {"app_name": "MUM", "public_address": "https://example.test/mum", "session_idle_days": 7, "session_max_days": 30},
		"with a query":        {"app_name": "MUM", "public_address": "https://example.test/?x=1", "session_idle_days": 7, "session_max_days": 30},
		"removed local":       {"app_name": "MUM", "public_address": "", "app_local_url": "", "session_idle_days": 7, "session_max_days": 30},
		"session setting":     {"app_name": "MUM", "public_address": "", "jwt_refresh_token_expires_days": 30, "session_idle_days": 7, "session_max_days": 30},
		"missing the address": {"app_name": "MUM", "session_idle_days": 7, "session_max_days": 30},
		"missing session days": {"app_name": "MUM", "public_address": ""},
		"idle over max":        {"app_name": "MUM", "public_address": "", "session_idle_days": 31, "session_max_days": 30},
		"idle zero":            {"app_name": "MUM", "public_address": "", "session_idle_days": 0, "session_max_days": 30},
		"max too long":         {"app_name": "MUM", "public_address": "", "session_idle_days": 7, "session_max_days": 366},
	} {
		if w := apiRequest(a, "PATCH", "/api/settings/general", ownerToken, bad, nil); w.Code != 400 {
			t.Fatal(name, "admitted", w.Code, w.Body.String())
		}
	}
	if got := responseData(t, apiRequest(a, "GET", "/api/settings/general", ownerToken, nil, nil)); got["app_name"] != "Family Media" {
		t.Fatal("rejected save changed settings", got)
	}
	// The public address is optional.
	if w := apiRequest(a, "PATCH", "/api/settings/general", ownerToken, map[string]any{"app_name": "Family Media", "public_address": "", "session_idle_days": 7, "session_max_days": 30}, nil); w.Code != 200 || responseData(t, w)["public_address"] != "" {
		t.Fatal("an empty public address was refused", w.Code, w.Body.String())
	}
	if w := apiRequest(a, "PATCH", "/api/settings/general", "", body, nil); w.Code != 401 {
		t.Fatal("anonymous save", w.Code)
	}
	activityExec(t, s, "DELETE FROM admin_privileges WHERE user_uuid=?", user)
	if w := apiRequest(a, "PATCH", "/api/settings/general", token, body, nil); w.Code != 403 {
		t.Fatal("ordinary account saved settings", w.Code)
	}
}

// Share links carry the public address when one is set, so a link copied from
// the home network still points where invitees can reach it.
func TestInvitationShareLinkPublicAddress(t *testing.T) {
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	f := newProvisioningFixture(t, "")
	id, _, _ := prepareInvitation(t, a, admin, f)
	path := fmt.Sprintf("/api/invitations/%d/share-link", id)
	if got := responseData(t, apiRequest(a, "GET", path, admin, nil, nil)); got["public_address"] != nil {
		t.Fatal("a public address without one set", got)
	}
	activityExec(t, s, "INSERT INTO settings(key,value) VALUES('APP_BASE_URL','https://mum.example.test') ON CONFLICT(key) DO UPDATE SET value=excluded.value")
	if got := responseData(t, apiRequest(a, "GET", path, admin, nil, nil)); got["public_address"] != "https://mum.example.test" {
		t.Fatal("share link without the public address", got)
	}
}
