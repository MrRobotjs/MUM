package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

type discordOAuthFixture struct {
	server    *httptest.Server
	mu        sync.Mutex
	user      string
	scope     string
	guilds    [][]string
	exchanges int
	onToken   func()
}

func newDiscordOAuthFixture(t *testing.T) *discordOAuthFixture {
	t.Helper()
	f := &discordOAuthFixture{user: "333456789012345678", scope: "identify guilds", guilds: [][]string{{"223456789012345678"}}}
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		user, scope, guilds, hook := f.user, f.scope, f.guilds, f.onToken
		f.mu.Unlock()
		switch {
		case r.Method == "POST" && r.URL.Path == "/oauth2/token":
			id, secret, _ := r.BasicAuth()
			_ = r.ParseForm()
			if id != discordFixtureClient || secret != "valid-discord-secret" {
				http.Error(w, `{"error":"invalid_client"}`, 401)
				return
			}
			if r.PostForm.Get("grant_type") == "client_credentials" {
				_, _ = w.Write([]byte(`{"access_token":"app","token_type":"Bearer"}`))
				return
			}
			if hook != nil {
				hook()
			}
			f.mu.Lock()
			f.exchanges++
			f.mu.Unlock()
			if r.PostForm.Get("grant_type") != "authorization_code" || r.PostForm.Get("code") != "good-code" || r.PostForm.Get("redirect_uri") != "https://mum.example"+discordInviteCallbackPath {
				http.Error(w, `{"error":"invalid_grant","private":"upstream detail"}`, 400)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "user-access-token-never-stored", "refresh_token": "user-refresh-token-never-stored", "token_type": "Bearer", "scope": scope})
		case r.URL.Path == "/users/@me":
			if r.Header.Get("Authorization") != "Bearer user-access-token-never-stored" {
				http.Error(w, "unauthorized", 401)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"id": user, "username": "discord_viewer", "avatar": "0123456789abcdef0123456789abcdef", "email": "private@example.invalid"})
		case r.URL.Path == "/users/@me/guilds":
			page := 0
			if after := r.URL.Query().Get("after"); after != "" {
				for i, ids := range guilds {
					if len(ids) > 0 && ids[len(ids)-1] == after {
						page = i + 1
					}
				}
			}
			out := []map[string]string{}
			if page < len(guilds) {
				for _, id := range guilds[page] {
					out = append(out, map[string]string{"id": id})
				}
			}
			_ = json.NewEncoder(w).Encode(out)
		default:
			t.Error("unexpected Discord request", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(f.server.Close)
	return f
}

func (f *discordOAuthFixture) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.exchanges
}

// discordInvitationApp configures verified Discord OAuth with a guild and one
// Jellyfin server, returning a helper that creates Discord-gated invitations.
func discordInvitationApp(t *testing.T) (*App, *Store, string, *discordOAuthFixture, func(guild bool) (int64, string)) {
	t.Helper()
	a, s := testApp(t)
	admin, _ := bootstrapOwner(t, a)
	f := newDiscordOAuthFixture(t)
	a.DiscordAPI = f.server.URL
	activityExec(t, s, "INSERT INTO settings(key,value,value_type) VALUES('APP_BASE_URL','https://mum.example','string') ON CONFLICT(key) DO UPDATE SET value=excluded.value")
	if w := apiRequest(a, "PATCH", "/api/settings/discord", admin, discordBody(1, map[string]any{"enable_oauth": true, "client_id": discordFixtureClient, "client_secret": "valid-discord-secret", "guild_id": "223456789012345678", "server_invite_url": "https://discord.gg/fixture"}), nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	provider := newProvisioningFixture(t, "")
	w := apiRequest(a, "POST", "/api/servers", admin, map[string]any{"server_nickname": "Discord gated", "service_type": "jellyfin", "url": provider.server.URL, "api_key": "fixture-secret"}, nil)
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	server := int64(responseData(t, w)["id"].(float64))
	if w := apiRequest(a, "POST", fmt.Sprintf("/api/servers/%d/sync", server), admin, nil, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	create := func(guild bool) (int64, string) {
		t.Helper()
		w := apiRequest(a, "POST", "/api/invitations", admin, map[string]any{"expires_at": time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano), "max_uses": 1, "grants": []InvitationGrant{{ServerID: server, LibraryIDs: []string{"movies"}}}, "require_discord_auth": true, "require_discord_guild_membership": guild}, nil)
		if w.Code != 201 {
			t.Fatal(w.Code, w.Body.String())
		}
		data := responseData(t, w)
		return int64(data["id"].(float64)), data["token"].(string)
	}
	return a, s, admin, f, create
}

// signIn starts a proof and completes the callback; it returns the browser cookie.
func signIn(t *testing.T, a *App, token, code string) (*http.Cookie, string, string) {
	t.Helper()
	w := apiRequest(a, "POST", "/api/public/invitations/"+token+"/discord-authorizations", "", map[string]any{"invitation_revision": 1}, nil)
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	var cookie *http.Cookie
	for _, c := range w.Result().Cookies() {
		if c.Name == discordInviteCookie {
			cookie = c
		}
	}
	if cookie == nil || !cookie.HttpOnly || cookie.SameSite != http.SameSiteLaxMode || cookie.Path != "/api/" {
		t.Fatal("browser binding cookie", cookie)
	}
	data := responseData(t, w)
	redirect, err := url.Parse(data["redirect_url"].(string))
	if err != nil || redirect.Host != "discord.com" || redirect.Path != "/oauth2/authorize" || redirect.Query().Get("client_id") != discordFixtureClient || redirect.Query().Get("redirect_uri") != "https://mum.example"+discordInviteCallbackPath {
		t.Fatal(data["redirect_url"])
	}
	state := redirect.Query().Get("state")
	callback := apiRequest(a, "GET", discordInviteCallbackPath+"?state="+url.QueryEscape(state)+"&code="+code, "", nil, cookie)
	return cookie, data["authorization_id"].(string), callback.Header().Get("Location") + "|" + redirect.Query().Get("scope") + "|" + state
}

func redeemWithDiscord(a *App, token, proof string, cookie *http.Cookie, username string) *httptest.ResponseRecorder {
	body := redeemBody(username, newUUID())
	if proof != "" {
		body["discord_authorization_id"] = proof
	}
	return apiRequest(a, "POST", "/api/public/invitations/"+token+"/redeem", "", body, cookie)
}

func TestInvitationDiscordSignInBindsVerifiedIdentityToRedemption(t *testing.T) {
	a, s, _, f, create := discordInvitationApp(t)
	_, token := create(true)
	public := responseData(t, apiRequest(a, "GET", "/api/public/invitations/"+token, "", nil, nil))["discord"].(map[string]any)
	if public["required"] != true || public["requires_guild"] != true || public["available"] != true || public["invite_url"] != "https://discord.gg/fixture" {
		t.Fatal(public)
	}
	if w := redeemWithDiscord(a, token, "", nil, "No Discord"); w.Code != 400 || !strings.Contains(w.Body.String(), "DISCORD_AUTH_REQUIRED") {
		t.Fatal("redemption without Discord", w.Code, w.Body.String())
	}
	// The code exchange runs outside the SQLite writer.
	f.onToken = func() {
		ctx, cancel := context.WithTimeout(t.Context(), time.Second)
		defer cancel()
		if err := s.write(ctx, func(tx *sql.Tx) error { return auditAction(ctx, tx, "", "fixture.concurrent_write") }); err != nil {
			t.Error("Discord exchange held the writer", err)
		}
	}
	cookie, proof, result := signIn(t, a, token, "good-code")
	parts := strings.Split(result, "|")
	if parts[0] != "/invite/"+token+"?discord=connected" || parts[1] != "identify guilds" {
		t.Fatal(parts)
	}
	// A replayed callback cannot exchange again.
	if w := apiRequest(a, "GET", discordInviteCallbackPath+"?state="+url.QueryEscape(parts[2])+"&code=good-code", "", nil, cookie); w.Header().Get("Location") != "/invite/"+token+"?discord=connected" || f.count() != 1 {
		t.Fatal("callback replayed", w.Header().Get("Location"), f.count())
	}
	status := apiRequest(a, "GET", "/api/public/invitations/"+token+"/discord-authorization", "", nil, cookie)
	body := status.Body.String()
	if status.Code != 200 || !strings.Contains(body, `"status":"verified"`) || !strings.Contains(body, "discord_viewer") || strings.Contains(body, "private@example.invalid") {
		t.Fatal(status.Code, body)
	}
	if w := apiRequest(a, "GET", "/api/public/invitations/"+token+"/discord-authorization", "", nil, nil); w.Code != 404 {
		t.Fatal("status without the browser cookie", w.Code)
	}
	other := &http.Cookie{Name: discordInviteCookie, Value: proof + "." + randomToken()}
	if w := redeemWithDiscord(a, token, proof, other, "Other Browser"); w.Code != 400 || !strings.Contains(w.Body.String(), "DISCORD_AUTH_REQUIRED") {
		t.Fatal("another browser redeemed the proof", w.Code, w.Body.String())
	}
	w := redeemWithDiscord(a, token, proof, cookie, "Discord Viewer")
	if w.Code != 201 || responseData(t, w)["status"] != "completed" {
		t.Fatal(w.Code, w.Body.String())
	}
	var discordID, discordName, proofStatus string
	s.reader.QueryRow("SELECT discord_user_id,discord_username FROM user_accounts WHERE local_username='Discord Viewer'").Scan(&discordID, &discordName)
	s.reader.QueryRow("SELECT status FROM invitation_discord_proofs WHERE id=?", proof).Scan(&proofStatus)
	if discordID != f.user || discordName != "discord_viewer" || proofStatus != "consumed" {
		t.Fatal(discordID, discordName, proofStatus)
	}
	// Discord user tokens and email are never persisted anywhere.
	for _, table := range []string{"invitation_discord_proofs", "user_accounts", "audit_events"} {
		rows, _ := s.reader.Query("SELECT * FROM " + table)
		cols, _ := rows.Columns()
		for rows.Next() {
			values := make([]any, len(cols))
			targets := make([]any, len(cols))
			for i := range values {
				targets[i] = &values[i]
			}
			rows.Scan(targets...)
			if text := fmt.Sprint(values...); strings.Contains(text, "never-stored") || strings.Contains(text, "private@example.invalid") {
				t.Fatal("Discord secret persisted in", table)
			}
		}
		rows.Close()
	}
	// The same Discord account cannot be bound to a second profile.
	_, second := create(false)
	cookie, proof, _ = signIn(t, a, second, "good-code")
	if w := redeemWithDiscord(a, second, proof, cookie, "Second Profile"); w.Code != 400 || !strings.Contains(w.Body.String(), "DISCORD_ACCOUNT_IN_USE") {
		t.Fatal("duplicate Discord identity", w.Code, w.Body.String())
	}
}

func TestInvitationDiscordRefusalsLeaveNoUsableProof(t *testing.T) {
	for _, mode := range []string{"denied", "bad_code", "scope", "no_guild", "guild_page_two", "no_cookie", "revision", "expired"} {
		t.Run(mode, func(t *testing.T) {
			a, s, admin, f, create := discordInvitationApp(t)
			inviteID, token := create(true)
			code := "good-code"
			switch mode {
			case "denied":
				code = "x&error=access_denied"
			case "bad_code":
				code = "wrong-code"
			case "scope":
				f.scope = "identify"
			case "no_guild":
				f.guilds = [][]string{{"999456789012345678"}}
			case "guild_page_two":
				page := []string{}
				for i := range 200 {
					page = append(page, fmt.Sprintf("1%017d", i))
				}
				f.guilds = [][]string{page, {"223456789012345678"}}
			}
			if mode == "no_cookie" {
				w := apiRequest(a, "POST", "/api/public/invitations/"+token+"/discord-authorizations", "", map[string]any{"invitation_revision": 1}, nil)
				state, _ := url.Parse(responseData(t, w)["redirect_url"].(string))
				callback := apiRequest(a, "GET", discordInviteCallbackPath+"?state="+url.QueryEscape(state.Query().Get("state"))+"&code=good-code", "", nil, nil)
				if callback.Header().Get("Location") != "/invite?discord=failed" || f.count() != 0 {
					t.Fatal("callback without browser binding", callback.Header().Get("Location"))
				}
				return
			}
			cookie, proof, result := signIn(t, a, token, code)
			location := strings.Split(result, "|")[0]
			switch mode {
			case "guild_page_two":
				if location != "/invite/"+token+"?discord=connected" {
					t.Fatal(location)
				}
				return
			case "revision":
				var revision float64
				w := apiRequest(a, "GET", fmt.Sprintf("/api/invitations/%d", inviteID), admin, nil, nil)
				data := responseData(t, w)
				revision = data["revision"].(float64)
				update := map[string]any{"revision": revision, "expires_at": data["expires_at"], "max_uses": 2, "is_active": true, "grants": data["grants"], "require_discord_auth": true, "require_discord_guild_membership": true}
				if w := apiRequest(a, "PATCH", fmt.Sprintf("/api/invitations/%d", inviteID), admin, update, nil); w.Code != 200 {
					t.Fatal(w.Code, w.Body.String())
				}
			case "expired":
				activityExec(t, s, "UPDATE invitation_discord_proofs SET expires_at='2000-01-01T00:00:00Z' WHERE id=?", proof)
			default:
				if location != "/invite/"+token+"?discord=failed" {
					t.Fatal(mode, location)
				}
				var status, errCode string
				s.reader.QueryRow("SELECT status,coalesce(error_code,'') FROM invitation_discord_proofs WHERE id=?", proof).Scan(&status, &errCode)
				if status != "failed" || errCode == "" {
					t.Fatal(mode, status, errCode)
				}
				if mode == "no_guild" {
					view := apiRequest(a, "GET", "/api/public/invitations/"+token+"/discord-authorization", "", nil, cookie)
					if !strings.Contains(view.Body.String(), "DISCORD_GUILD_REQUIRED") || !strings.Contains(view.Body.String(), "discord.gg/fixture") || strings.Contains(view.Body.String(), "discord_viewer") {
						t.Fatal(view.Body.String())
					}
				}
			}
			if w := redeemWithDiscord(a, token, proof, cookie, "Refused "+mode); w.Code != 400 || !strings.Contains(w.Body.String(), "DISCORD_AUTH_REQUIRED") {
				t.Fatal(mode, w.Code, w.Body.String())
			}
			var jobs int
			s.reader.QueryRow("SELECT count(*) FROM provisioning_jobs").Scan(&jobs)
			if jobs != 0 {
				t.Fatal("refused Discord redemption reserved capacity")
			}
		})
	}
}

func TestInvitationDiscordConfigurationAndRecovery(t *testing.T) {
	a, s, admin, _, create := discordInvitationApp(t)
	_, token := create(false)
	grant := []InvitationGrant{{ServerID: 1, LibraryIDs: []string{"movies"}}}
	expires := time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano)
	if w := apiRequest(a, "POST", "/api/invitations", admin, map[string]any{"expires_at": expires, "max_uses": 1, "grants": grant, "require_discord_guild_membership": true}, nil); w.Code != 409 {
		t.Fatal("guild without sign-in accepted", w.Code)
	}
	activityExec(t, s, "UPDATE discord_settings SET guild_id=NULL")
	if w := apiRequest(a, "POST", "/api/invitations", admin, map[string]any{"expires_at": expires, "max_uses": 1, "grants": grant, "require_discord_auth": true, "require_discord_guild_membership": true}, nil); w.Code != 409 {
		t.Fatal("guild requirement without a configured guild", w.Code)
	}
	// Starting needs a Discord-gated invitation, and the current revision.
	if w := apiRequest(a, "POST", "/api/public/invitations/"+token+"/discord-authorizations", "", map[string]any{"invitation_revision": 9}, nil); w.Code != 409 {
		t.Fatal("stale revision started", w.Code)
	}
	activityExec(t, s, "INSERT INTO invitation_discord_proofs(id,invite_id,invitation_revision,settings_revision,require_guild,state_hash,browser_hash,status,created_at,expires_at,updated_at) SELECT ?,id,1,1,0,'s','b','exchanging',?,?,? FROM invites WHERE token=?", newUUID(), utcTimestamp(time.Now()), utcTimestamp(time.Now().Add(time.Minute)), utcTimestamp(time.Now()), tokenHash(token))
	if err := a.recoverProvisioning(context.Background()); err != nil {
		t.Fatal(err)
	}
	var status, code string
	s.reader.QueryRow("SELECT status,error_code FROM invitation_discord_proofs WHERE state_hash='s'").Scan(&status, &code)
	if status != "failed" || code != "INTERRUPTED" {
		t.Fatal("interrupted exchange resumed", status, code)
	}
	// Disabling Discord OAuth makes gated invitations unavailable to start.
	activityExec(t, s, "UPDATE discord_settings SET oauth_enabled=0")
	if w := apiRequest(a, "POST", "/api/public/invitations/"+token+"/discord-authorizations", "", map[string]any{"invitation_revision": 1}, nil); w.Code != 409 {
		t.Fatal("start with Discord disabled", w.Code)
	}
}
