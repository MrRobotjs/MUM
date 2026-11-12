package main

import (
	"strings"
	"testing"
)

func TestGeneralSettingsSaveValidatesAuditsAndPersists(t *testing.T) {
	a, s, ownerToken, token, user := roleReadFixture(t)
	body := map[string]any{"app_name": "Family Media", "app_base_url": "https://media.example.test", "app_local_url": ""}
	w := apiRequest(a, "PATCH", "/api/settings/general", ownerToken, body, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if got := responseData(t, w); got["app_name"] != "Family Media" || got["app_base_url"] != "https://media.example.test" || got["app_local_url"] != "" {
		t.Fatal("saved settings", got)
	}
	if got := responseData(t, apiRequest(a, "GET", "/api/settings/general", ownerToken, nil, nil)); got["app_name"] != "Family Media" ||
		got["jwt_access_token_expires_minutes"] != float64(15) || got["jwt_refresh_token_expires_days"] != float64(14) || got["jwt_cookie_secure"] != false {
		t.Fatal("settings not persisted or fixed session values not reported", got)
	}
	var audits int
	s.reader.QueryRow("SELECT count(*) FROM audit_events WHERE action='settings.general.save'").Scan(&audits)
	if audits != 1 {
		t.Fatal("save not audited", audits)
	}
	for name, bad := range map[string]map[string]any{
		"empty name":      {"app_name": " ", "app_base_url": "", "app_local_url": ""},
		"long name":       {"app_name": strings.Repeat("x", 101), "app_base_url": "", "app_local_url": ""},
		"bad base url":    {"app_name": "MUM", "app_base_url": "ftp://example.test", "app_local_url": ""},
		"bad local url":   {"app_name": "MUM", "app_base_url": "", "app_local_url": "not a url"},
		"session setting": {"app_name": "MUM", "app_base_url": "", "app_local_url": "", "jwt_refresh_token_expires_days": 30},
		"missing field":   {"app_name": "MUM"},
	} {
		if w := apiRequest(a, "PATCH", "/api/settings/general", ownerToken, bad, nil); w.Code != 400 {
			t.Fatal(name, "admitted", w.Code, w.Body.String())
		}
	}
	if got := responseData(t, apiRequest(a, "GET", "/api/settings/general", ownerToken, nil, nil)); got["app_name"] != "Family Media" {
		t.Fatal("rejected save changed settings", got)
	}
	if w := apiRequest(a, "PATCH", "/api/settings/general", "", body, nil); w.Code != 401 {
		t.Fatal("anonymous save", w.Code)
	}
	activityExec(t, s, "DELETE FROM admin_privileges WHERE user_uuid=?", user)
	if w := apiRequest(a, "PATCH", "/api/settings/general", token, body, nil); w.Code != 403 {
		t.Fatal("ordinary account saved settings", w.Code)
	}
}
