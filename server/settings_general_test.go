package main

import (
	"fmt"
	"strings"
	"testing"
)

func TestGeneralSettingsSaveValidatesAuditsAndPersists(t *testing.T) {
	a, s, ownerToken, token, user := roleReadFixture(t)
	activityExec(t, s, "INSERT INTO settings(key,value) VALUES('APP_LOCAL_URL','http://192.168.1.10:5699') ON CONFLICT(key) DO UPDATE SET value=excluded.value")
	body := map[string]any{"app_name": "Family Media", "public_address": "https://media.example.test/"}
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
		got["jwt_access_token_expires_minutes"] != float64(15) || got["jwt_refresh_token_expires_days"] != float64(14) || got["jwt_cookie_secure"] != false {
		t.Fatal("settings not persisted or fixed session values not reported", got)
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
		"empty name":          {"app_name": " ", "public_address": ""},
		"long name":           {"app_name": strings.Repeat("x", 101), "public_address": ""},
		"not http":            {"app_name": "MUM", "public_address": "ftp://example.test"},
		"not an address":      {"app_name": "MUM", "public_address": "mum.example.test"},
		"with credentials":    {"app_name": "MUM", "public_address": "https://user:pass@example.test"},
		"with a path":         {"app_name": "MUM", "public_address": "https://example.test/mum"},
		"with a query":        {"app_name": "MUM", "public_address": "https://example.test/?x=1"},
		"removed local":       {"app_name": "MUM", "public_address": "", "app_local_url": ""},
		"session setting":     {"app_name": "MUM", "public_address": "", "jwt_refresh_token_expires_days": 30},
		"missing the address": {"app_name": "MUM"},
	} {
		if w := apiRequest(a, "PATCH", "/api/settings/general", ownerToken, bad, nil); w.Code != 400 {
			t.Fatal(name, "admitted", w.Code, w.Body.String())
		}
	}
	if got := responseData(t, apiRequest(a, "GET", "/api/settings/general", ownerToken, nil, nil)); got["app_name"] != "Family Media" {
		t.Fatal("rejected save changed settings", got)
	}
	// The public address is optional.
	if w := apiRequest(a, "PATCH", "/api/settings/general", ownerToken, map[string]any{"app_name": "Family Media", "public_address": ""}, nil); w.Code != 200 || responseData(t, w)["public_address"] != "" {
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
