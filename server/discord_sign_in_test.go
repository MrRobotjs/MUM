package main

import (
	"net/http"
	"net/url"
	"testing"
	"time"
)

// discordSignInApp turns on verified Discord with the fixture and returns the
// owner's token and a member's account and token.
func discordSignInApp(t *testing.T, signIn, admins bool) (*App, *Store, *discordOAuthFixture, string, string, string) {
	t.Helper()
	a, s := testApp(t)
	owner, _ := bootstrapOwner(t, a)
	f := newDiscordOAuthFixture(t)
	a.DiscordAPI = f.server.URL
	activityExec(t, s, "INSERT INTO settings(key,value,value_type) VALUES('APP_BASE_URL','https://mum.example','string') ON CONFLICT(key) DO UPDATE SET value=excluded.value")
	if w := apiRequest(a, "PATCH", "/api/settings/discord", owner, discordBody(1, map[string]any{"enable_oauth": true, "client_id": discordFixtureClient, "client_secret": "valid-discord-secret", "sign_in_enabled": signIn, "sign_in_admins": admins}), nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	ownerP, _ := s.Authenticate(t.Context(), owner)
	member, err := s.CreateAccount(t.Context(), ownerP.UUID, "member", "fixture-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	session, err := s.issueSession(t.Context(), member, false)
	if err != nil {
		t.Fatal(err)
	}
	return a, s, f, owner, member, session.Access
}

// discordRoundTrip starts an attempt at path (with token when signed in),
// then plays Discord returning to the callback with code. It returns where
// MUM sent the browser and the callback's cookies.
func discordRoundTrip(t *testing.T, a *App, path, token, code string) (string, []*http.Cookie) {
	t.Helper()
	w := apiRequest(a, "POST", path, token, map[string]any{"remember": false}, nil)
	if w.Code != 201 {
		t.Fatal("start", path, w.Code, w.Body.String())
	}
	var cookie *http.Cookie
	for _, c := range w.Result().Cookies() {
		if c.Name == discordAuthCookie {
			cookie = c
		}
	}
	if cookie == nil || !cookie.HttpOnly || cookie.SameSite != http.SameSiteLaxMode || cookie.Path != "/api/discord/" {
		t.Fatal("browser binding cookie", cookie)
	}
	redirect, err := url.Parse(responseData(t, w)["redirect_url"].(string))
	if err != nil || redirect.Host != "discord.com" || redirect.Query().Get("scope") != "identify" || redirect.Query().Get("redirect_uri") != "https://mum.example"+discordCallbackPath {
		t.Fatal("authorize URL", redirect)
	}
	callback := apiRequest(a, "GET", discordCallbackPath+"?state="+url.QueryEscape(redirect.Query().Get("state"))+"&code="+code, "", nil, cookie)
	if callback.Code != http.StatusSeeOther {
		t.Fatal("callback", callback.Code)
	}
	return callback.Header().Get("Location"), callback.Result().Cookies()
}

func discordLinked(t *testing.T, s *Store, user string) string {
	t.Helper()
	var id string
	_ = s.reader.QueryRow("SELECT coalesce(discord_user_id,'') FROM user_accounts WHERE uuid=?", user).Scan(&id)
	return id
}

// Any account links its own Discord account on the account page; one Discord
// account belongs to one profile, and unlinking clears it.
func TestDiscordLinkAndUnlink(t *testing.T) {
	a, s, f, owner, member, token := discordSignInApp(t, false, false)
	if p := responseData(t, apiRequest(a, "GET", "/api/account/discord", token, nil, nil)); p["available"] != true || p["linked"] != false {
		t.Fatal(p)
	}
	if where, _ := discordRoundTrip(t, a, "/api/account/discord", token, "good-code"); where != "/account?tab=credentials&discord=linked" || discordLinked(t, s, member) != f.user {
		t.Fatal(where, discordLinked(t, s, member))
	}
	p := responseData(t, apiRequest(a, "GET", "/api/account/discord", token, nil, nil))
	if p["linked"] != true || p["username"] != "discord_viewer" {
		t.Fatal(p)
	}
	if u := responseData(t, apiRequest(a, "GET", "/api/users/"+member, owner, nil, nil)); u["discord_username"] != "discord_viewer" || u["discord_user_id"] != f.user {
		t.Fatal("user page", u["discord_username"], u["discord_user_id"])
	}
	// The owner cannot take the same Discord account.
	if where, _ := discordRoundTrip(t, a, "/api/account/discord", owner, "good-code"); where != "/account?tab=credentials&discord=in_use" {
		t.Fatal(where)
	}
	// A refused code links nothing.
	if w := apiRequest(a, "DELETE", "/api/account/discord", token, nil, nil); w.Code != 200 || discordLinked(t, s, member) != "" {
		t.Fatal("unlink", w.Code)
	}
	if where, _ := discordRoundTrip(t, a, "/api/account/discord", token, "bad-code"); where != "/account?tab=credentials&discord=failed" || discordLinked(t, s, member) != "" {
		t.Fatal(where)
	}
}

// The callback works once, only in the browser that started it.
func TestDiscordCallbackIsBoundAndSingleUse(t *testing.T) {
	a, s, f, _, member, token := discordSignInApp(t, false, false)
	w := apiRequest(a, "POST", "/api/account/discord", token, map[string]any{}, nil)
	var cookie *http.Cookie
	for _, c := range w.Result().Cookies() {
		if c.Name == discordAuthCookie {
			cookie = c
		}
	}
	redirect, _ := url.Parse(responseData(t, w)["redirect_url"].(string))
	callback := discordCallbackPath + "?state=" + url.QueryEscape(redirect.Query().Get("state")) + "&code=good-code"
	if got := apiRequest(a, "GET", callback, "", nil, nil).Header().Get("Location"); got != "/account?tab=credentials&discord=failed" || f.count() != 0 {
		t.Fatal("callback without the browser cookie", got, f.count())
	}
	if got := apiRequest(a, "GET", callback, "", nil, cookie).Header().Get("Location"); got != "/account?tab=credentials&discord=linked" {
		t.Fatal(got)
	}
	activityExec(t, s, "UPDATE user_accounts SET discord_user_id=NULL WHERE uuid=?", member)
	if got := apiRequest(a, "GET", callback, "", nil, cookie).Header().Get("Location"); got != "/account?tab=credentials&discord=failed" || f.count() != 1 || discordLinked(t, s, member) != "" {
		t.Fatal("replayed callback", got, f.count())
	}
}

// Sign in with Discord: off by default; only a linked account signs in; the
// session stops working when Discord is unlinked or sign-in is turned off.
func TestDiscordSignIn(t *testing.T) {
	a, s, _, owner, _, token := discordSignInApp(t, false, false)
	if w := apiRequest(a, "POST", "/api/auth/discord", "", map[string]any{"remember": false}, nil); w.Code != 409 {
		t.Fatal("sign-in while off", w.Code)
	}
	if responseData(t, apiRequest(a, "GET", "/api/auth/methods", "", nil, nil))["discord"] != false {
		t.Fatal("methods while off")
	}
	revision := discordRead(t, a, owner)["revision"]
	if w := apiRequest(a, "PATCH", "/api/settings/discord", owner, discordBody(revision, map[string]any{"enable_oauth": true, "sign_in_enabled": true}), nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if responseData(t, apiRequest(a, "GET", "/api/auth/methods", "", nil, nil))["discord"] != true {
		t.Fatal("methods while on")
	}
	if where, cookies := discordRoundTrip(t, a, "/api/auth/discord", "", "good-code"); where != "/login?discord=not_linked" || refreshCookie(cookies) != nil {
		t.Fatal("unlinked Discord signed in", where)
	}
	discordRoundTrip(t, a, "/api/account/discord", token, "good-code")
	where, cookies := discordRoundTrip(t, a, "/api/auth/discord", "", "good-code")
	refresh := refreshCookie(cookies)
	if where != "/login?discord=signed_in" || refresh == nil {
		t.Fatal(where, refresh)
	}
	w := apiRequest(a, "POST", "/api/auth/refresh", "", nil, refresh)
	if w.Code != 200 {
		t.Fatal("refresh", w.Code, w.Body.String())
	}
	access := responseData(t, w)["access_token"].(string)
	var origin string
	_ = s.reader.QueryRow("SELECT s.sign_in_origin FROM app_sessions s JOIN session_access_tokens t ON t.session_id=s.id WHERE t.token_hash=?", tokenHash(access)).Scan(&origin)
	if origin != "discord" || apiRequest(a, "GET", "/api/auth/session", access, nil, nil).Code != 200 {
		t.Fatal("Discord session", origin)
	}
	// Turning sign-in off stops the session at once.
	revision = discordRead(t, a, owner)["revision"]
	apiRequest(a, "PATCH", "/api/settings/discord", owner, discordBody(revision, map[string]any{"enable_oauth": true}), nil)
	if apiRequest(a, "GET", "/api/auth/session", access, nil, nil).Code == 200 {
		t.Fatal("session survived sign-in being turned off")
	}
	revision = discordRead(t, a, owner)["revision"]
	apiRequest(a, "PATCH", "/api/settings/discord", owner, discordBody(revision, map[string]any{"enable_oauth": true, "sign_in_enabled": true}), nil)
	if apiRequest(a, "GET", "/api/auth/session", access, nil, nil).Code != 200 {
		t.Fatal("session after sign-in turned back on")
	}
	// A session belongs to the Discord account it signed in with.
	activityExec(t, s, "UPDATE user_accounts SET discord_user_id='444456789012345678' WHERE discord_user_id IS NOT NULL")
	if apiRequest(a, "GET", "/api/auth/session", access, nil, nil).Code == 200 {
		t.Fatal("session survived a different Discord account")
	}
	activityExec(t, s, "UPDATE user_accounts SET discord_user_id='333456789012345678' WHERE discord_user_id IS NOT NULL")
	// Unlinking stops it too, and ends the account's Discord sessions.
	apiRequest(a, "DELETE", "/api/account/discord", token, nil, nil)
	if apiRequest(a, "GET", "/api/auth/session", access, nil, nil).Code == 200 {
		t.Fatal("session survived unlinking")
	}
}

// The owner always uses the MUM password; accounts with admin access sign in
// with Discord only when the second switch allows it.
func TestDiscordSignInOwnerAndAdministratorRules(t *testing.T) {
	a, s, _, owner, member, token := discordSignInApp(t, true, false)
	discordRoundTrip(t, a, "/api/account/discord", owner, "good-code")
	if where, cookies := discordRoundTrip(t, a, "/api/auth/discord", "", "good-code"); where != "/login?discord=password_required" || refreshCookie(cookies) != nil {
		t.Fatal("owner signed in with Discord", where)
	}
	ownerP, _ := s.Authenticate(t.Context(), owner)
	activityExec(t, s, "UPDATE user_accounts SET discord_user_id=NULL,discord_username=NULL WHERE uuid=?", ownerP.UUID)
	activityExec(t, s, "INSERT INTO admin_roles(id,name,position) VALUES('adm','Admins',20)")
	activityExec(t, s, "INSERT INTO admin_role_permissions(role_id,permission_id) SELECT 'adm',id FROM admin_permissions WHERE name='administrator'")
	if err := s.AssignAdminRole(t.Context(), ownerP.UUID, member, "adm"); err != nil {
		t.Fatal(err)
	}
	discordRoundTrip(t, a, "/api/account/discord", token, "good-code")
	if where, _ := discordRoundTrip(t, a, "/api/auth/discord", "", "good-code"); where != "/login?discord=password_required" {
		t.Fatal("administrator signed in without the switch", where)
	}
	revision := discordRead(t, a, owner)["revision"]
	if w := apiRequest(a, "PATCH", "/api/settings/discord", owner, discordBody(revision, map[string]any{"enable_oauth": true, "sign_in_enabled": true, "sign_in_admins": true}), nil); w.Code != 200 {
		t.Fatal(w.Code)
	}
	if where, cookies := discordRoundTrip(t, a, "/api/auth/discord", "", "good-code"); where != "/login?discord=signed_in" || refreshCookie(cookies) == nil {
		t.Fatal("administrator with the switch", where)
	}
}

func refreshCookie(cookies []*http.Cookie) *http.Cookie {
	for _, c := range cookies {
		if c.Name == "mum_refresh" && c.Value != "" {
			return c
		}
	}
	return nil
}

// Migration 077 rebuilds the sessions table for the new origin; everyone stays
// signed in, and an account's sessions and access tokens still go with it.
func TestDiscordMigrationKeepsSessions(t *testing.T) {
	db, path := databaseBefore(t, "077")
	now := utcTimestamp(time.Now())
	later := utcTimestamp(time.Now().Add(time.Hour))
	for _, statement := range []string{
		"INSERT INTO identities(uuid,kind) VALUES('11111111-1111-4111-8111-111111111111','local')",
		"INSERT INTO user_accounts(uuid,kind,local_username,created_at,updated_at) VALUES('11111111-1111-4111-8111-111111111111','local','kept','" + now + "','" + now + "')",
		"INSERT INTO app_sessions(id,user_uuid,access_hash,refresh_hash,access_expires_at,refresh_expires_at,created_at) VALUES('s1','11111111-1111-4111-8111-111111111111','a1','r1','" + later + "','" + later + "','" + now + "')",
		"INSERT INTO session_access_tokens VALUES('a1','s1','" + later + "')",
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(statement, err)
		}
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	s, err := OpenStore(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var origin string
	var tokens int
	if err := s.reader.QueryRow("SELECT s.sign_in_origin,(SELECT count(*) FROM session_access_tokens WHERE session_id=s.id) FROM app_sessions s WHERE s.id='s1'").Scan(&origin, &tokens); err != nil || origin != "password" || tokens != 1 {
		t.Fatal("session", origin, tokens, err)
	}
	if _, err := s.writer.Exec("DELETE FROM user_accounts WHERE uuid='11111111-1111-4111-8111-111111111111'"); err != nil {
		t.Fatal(err)
	}
	var left int
	if err := s.reader.QueryRow("SELECT (SELECT count(*) FROM app_sessions)+(SELECT count(*) FROM session_access_tokens)").Scan(&left); err != nil || left != 0 {
		t.Fatal("sessions outlived their account", left, err)
	}
}
