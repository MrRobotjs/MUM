package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

const discordFixtureClient = "123456789012345678"

func discordFixture(t *testing.T, a *App) *atomic.Int32 {
	t.Helper()
	calls := &atomic.Int32{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		id, secret, ok := r.BasicAuth()
		if r.Method != "POST" || r.URL.Path != "/oauth2/token" || r.ParseForm() != nil || r.PostForm.Get("grant_type") != "client_credentials" || r.PostForm.Get("scope") != "identify" {
			t.Error("unexpected Discord request", r.Method, r.URL.Path, r.PostForm)
		}
		if !ok || id != discordFixtureClient || secret != "valid-discord-secret" {
			http.Error(w, `{"error":"invalid_client","detail":"private upstream detail"}`, 401)
			return
		}
		_, _ = w.Write([]byte(`{"access_token":"discarded-app-token","token_type":"Bearer","expires_in":604800}`))
	}))
	t.Cleanup(server.Close)
	a.DiscordAPI = server.URL
	return calls
}

func discordBody(revision any, extra map[string]any) map[string]any {
	body := map[string]any{"revision": revision, "enable_oauth": false, "enable_bot": false, "enable_membership_requirement": false, "default_require_discord_auth": false, "default_require_discord_guild_membership": false,
		"client_id": "", "client_secret": "", "oauth_auth_url": "", "guild_id": "", "server_invite_url": "", "bot_token": "", "monitored_role_id": "", "thread_channel_id": "", "bot_log_channel_id": "",
		"whitelist_sharers": false, "redirect_uri_invite": "", "redirect_uri_admin": ""}
	for k, v := range extra {
		body[k] = v
	}
	return body
}

func discordRead(t *testing.T, a *App, token string) map[string]any {
	t.Helper()
	w := apiRequest(a, "GET", "/api/settings/discord", token, nil, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	return responseData(t, w)
}

func TestDiscordSettingsVerifiedWriteOnlyAndRevisionGuarded(t *testing.T) {
	a, s, token, member, user := roleReadFixture(t)
	calls := discordFixture(t, a)
	p := discordRead(t, a, token)
	if p["enable_oauth"] != false || p["client_secret_set"] != false || p["enable_bot"] != false || p["revision"] != float64(1) {
		t.Fatal(p)
	}
	if w := apiRequest(a, "PATCH", "/api/settings/discord", token, discordBody(nil, nil), nil); w.Code != 400 {
		t.Fatal("missing revision accepted", w.Code)
	}
	// Rejected credentials are never stored and upstream text is never echoed.
	w := apiRequest(a, "PATCH", "/api/settings/discord", token, discordBody(1, map[string]any{"enable_oauth": true, "client_id": discordFixtureClient, "client_secret": "wrong"}), nil)
	if w.Code != 502 || strings.Contains(w.Body.String(), "private upstream detail") {
		t.Fatal(w.Code, w.Body.String())
	}
	if p = discordRead(t, a, token); p["client_secret_set"] != false || p["revision"] != float64(1) {
		t.Fatal("rejected credentials saved", p)
	}
	w = apiRequest(a, "PATCH", "/api/settings/discord", token, discordBody(1, map[string]any{"enable_oauth": true, "client_id": discordFixtureClient, "client_secret": "valid-discord-secret", "guild_id": "223456789012345678", "server_invite_url": "https://discord.gg/fixture"}), nil)
	if w.Code != 200 || strings.Contains(w.Body.String(), "valid-discord-secret") || strings.Contains(w.Body.String(), "discarded-app-token") {
		t.Fatal(w.Code, w.Body.String())
	}
	p = responseData(t, w)
	if p["enable_oauth"] != true || p["client_secret_set"] != true || p["verified_at"] == nil || p["guild_id"] != "223456789012345678" || p["revision"] != float64(2) {
		t.Fatal(p)
	}
	// Unchanged credentials (secret omitted) are kept and not re-verified.
	before := calls.Load()
	if w = apiRequest(a, "PATCH", "/api/settings/discord", token, discordBody(2, map[string]any{"enable_oauth": true, "client_id": discordFixtureClient}), nil); w.Code != 200 || calls.Load() != before {
		t.Fatal("unchanged credentials re-verified", w.Code, calls.Load()-before)
	}
	if w = apiRequest(a, "PATCH", "/api/settings/discord", token, discordBody(2, nil), nil); w.Code != 409 {
		t.Fatal("stale revision accepted", w.Code)
	}
	// Disabling keeps the stored credentials for a later re-enable.
	if w = apiRequest(a, "PATCH", "/api/settings/discord", token, discordBody(3, nil), nil); w.Code != 200 || responseData(t, w)["client_secret_set"] != true || responseData(t, w)["enable_oauth"] != false {
		t.Fatal(w.Code, w.Body.String())
	}
	var audits string
	s.reader.QueryRow("SELECT group_concat(details,'|') FROM audit_events WHERE action='settings.discord.save'").Scan(&audits)
	if strings.Count(audits, `"enable_oauth"`) != 3 || strings.Contains(audits, "valid-discord-secret") {
		t.Fatal(audits)
	}
	activityExec(t, s, "DELETE FROM admin_privileges WHERE user_uuid=?", user)
	if w := apiRequest(a, "GET", "/api/settings/discord", member, nil, nil); w.Code != 403 {
		t.Fatal("non-administrator read Discord settings", w.Code)
	}
}

func TestDiscordSettingsRefuseUnimplementedFeaturesAndInvalidValues(t *testing.T) {
	a, _, token, _, _ := roleReadFixture(t)
	calls := discordFixture(t, a)
	for _, extra := range []map[string]any{{"enable_bot": true}, {"enable_membership_requirement": true}, {"default_require_discord_auth": true}, {"default_require_discord_guild_membership": true}, {"whitelist_sharers": true}, {"bot_token": "x"}, {"monitored_role_id": "1"}, {"oauth_auth_url": "https://discord.com/api/v10/oauth2/authorize"}, {"redirect_uri_admin": "https://mum.example/x"}} {
		if w := apiRequest(a, "PATCH", "/api/settings/discord", token, discordBody(1, extra), nil); w.Code != 422 {
			t.Fatal(extra, w.Code)
		}
	}
	for _, extra := range []map[string]any{{"client_id": "not-numeric"}, {"guild_id": "12"}, {"server_invite_url": "https://evil.invalid/x"}, {"server_invite_url": "http://discord.gg/x"}, {"redirect_uri_invite": "/relative"}, {"client_secret": "has space"}} {
		if w := apiRequest(a, "PATCH", "/api/settings/discord", token, discordBody(1, extra), nil); w.Code != 400 {
			t.Fatal(extra, w.Code)
		}
	}
	if w := apiRequest(a, "PATCH", "/api/settings/discord", token, discordBody(1, map[string]any{"enable_oauth": true}), nil); w.Code != 400 {
		t.Fatal("enabled without credentials", w.Code)
	}
	if calls.Load() != 0 || discordRead(t, a, token)["revision"] != float64(1) {
		t.Fatal("refused settings contacted Discord or saved")
	}
}

func TestDiscordRedirectAndConnectionTest(t *testing.T) {
	a, s, token, _, _ := roleReadFixture(t)
	discordFixture(t, a)
	activityExec(t, s, "INSERT INTO settings(key,value,value_type) VALUES('APP_BASE_URL','https://mum.example/','string') ON CONFLICT(key) DO UPDATE SET value=excluded.value")
	if p := discordRead(t, a, token); p["redirect_uri_invite"] != "https://mum.example"+discordInviteCallbackPath || p["redirect_uri_admin"] != nil {
		t.Fatal(p)
	}
	test := func(kind string) map[string]any {
		w := apiRequest(a, "POST", "/api/settings/discord/test", token, map[string]any{"type": kind}, nil)
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
		return responseData(t, w)
	}
	if r := test("oauth"); r["success"] != false {
		t.Fatal("unconfigured test passed", r)
	}
	// Pinning the computed default stores nothing; a different URI is pinned.
	w := apiRequest(a, "PATCH", "/api/settings/discord", token, discordBody(1, map[string]any{"enable_oauth": true, "client_id": discordFixtureClient, "client_secret": "valid-discord-secret", "redirect_uri_invite": "https://mum.example" + discordInviteCallbackPath}), nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var pinned string
	s.reader.QueryRow("SELECT coalesce(redirect_uri_invite,'') FROM discord_settings").Scan(&pinned)
	if pinned != "" {
		t.Fatal("default redirect pinned", pinned)
	}
	if r := test("oauth"); r["success"] != true {
		t.Fatal(r)
	}
	if r := test("bot"); r["success"] != false || !strings.Contains(r["message"].(string), "not available") {
		t.Fatal(r)
	}
	activityExec(t, s, "UPDATE discord_settings SET client_secret='rotated-elsewhere'")
	if r := test("oauth"); r["success"] != false || r["message"] != "Discord rejected the client ID or secret" {
		t.Fatal(r)
	}
	if w := apiRequest(a, "POST", "/api/settings/discord/test", token, map[string]any{"type": "other"}, nil); w.Code != 400 {
		t.Fatal(w.Code)
	}
}
