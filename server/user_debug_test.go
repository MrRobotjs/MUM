package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestUserDebugShowsStoredRecordsWithoutRawPayloads(t *testing.T) {
	f := activityReadFixture(t)
	activityExec(t, f.store, `UPDATE service_accounts SET external_username='remote-viewer',external_email='viewer@example.invalid',allowed_library_ids='["movies"]',service_settings='{"all_libraries":false}',user_raw_data='{"AccessToken":"raw-provider-secret"}',stream_raw_data='{"token":"raw-stream-secret"}' WHERE uuid=?`, f.service)
	read := func(target, token string) (int, string) {
		w := apiRequest(f.app, "GET", "/api/users/"+target+"/debug", token, nil, nil)
		return w.Code, w.Body.String()
	}
	for _, target := range []string{f.service, f.user} {
		code, body := read(target, f.ownerToken)
		if code != 200 || strings.Contains(body, "raw-provider-secret") || strings.Contains(body, "raw-stream-secret") || strings.Contains(body, "fixture-secret") {
			t.Fatal(target, code, body)
		}
		var payload struct {
			Data struct {
				Info     map[string]any   `json:"user_info"`
				Services []map[string]any `json:"service_data"`
				HasData  bool             `json:"has_data"`
			} `json:"data"`
		}
		if err := json.Unmarshal([]byte(body), &payload); err != nil || !payload.Data.HasData || len(payload.Data.Services) != 1 {
			t.Fatal(body)
		}
		record := payload.Data.Services[0]["raw_data"].(map[string]any)
		if record["external_username"] != "remote-viewer" || record["service_uuid"] != f.service || payload.Data.Services[0]["service_settings"].(map[string]any)["all_libraries"] != false {
			t.Fatal(record)
		}
		if target == f.service && payload.Data.Info["service_type"] != "jellyfin" {
			t.Fatal(payload.Data.Info)
		}
	}
	if code, _ := read(newUUID(), f.ownerToken); code != 404 {
		t.Fatal("unknown identity", code)
	}
	activityExec(t, f.store, "DELETE FROM admin_privileges WHERE user_uuid=?", f.user)
	if code, _ := read(f.service, f.token); code != 403 {
		t.Fatal("non-administrator read debug data", code)
	}
}
