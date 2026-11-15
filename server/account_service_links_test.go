package main

import (
	"net/http/httptest"
	"testing"
	"time"
)

// signInAsAlice signs in through the Jellyfin fixture, creating alice's
// passwordless MUM account on first use, and returns its token and UUID.
func signInAsAlice(t *testing.T, f serviceLoginFixture) (string, string) {
	t.Helper()
	w := serviceSignIn(f.a, f.server, "alice", serviceFixturePassword)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	data := responseData(t, w)
	return data["access_token"].(string), data["user"].(map[string]any)["uuid"].(string)
}

func linkRequest(f serviceLoginFixture, token, username, password string) *httptest.ResponseRecorder {
	return apiRequest(f.a, "POST", "/api/account/service-links", token, map[string]any{"server_id": f.server, "username": username, "password": password}, nil)
}

func passwordMember(t *testing.T, f serviceLoginFixture, name string) (string, string) {
	t.Helper()
	hash, err := hashPassword("a-strong-member-password")
	if err != nil {
		t.Fatal(err)
	}
	user, err := f.s.CreateAccount(t.Context(), f.ownerID, name, hash, false)
	if err != nil {
		t.Fatal(err)
	}
	w := apiRequest(f.a, "POST", "/api/auth/login", "", map[string]any{"username": name, "password": "a-strong-member-password"}, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	return responseData(t, w)["access_token"].(string), user
}

func TestSelfLinkUnownedAccount(t *testing.T) {
	f := newServiceLoginFixture(t)
	seedExternalService(t, f.s, f.server, aliceJellyfinID)
	bob := seedExternalService(t, f.s, f.server, "b0b")
	token, alice := signInAsAlice(t, f)
	if w := linkRequest(f, token, "bob", "wrong-password"); w.Code != 401 || errorCode(t, w.Body.String()) != "SERVICE_SIGN_IN_FAILED" {
		t.Fatal("linked without the account's password", w.Code, w.Body.String())
	}
	if w := linkRequest(f, token, "bob", serviceFixturePassword); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if countRows(t, f.s, "SELECT count(*) FROM service_links WHERE user_uuid=? AND service_uuid=? AND link_kind='owner'", alice, bob) != 1 {
		t.Fatal("bob not linked to alice's account")
	}
	if countRows(t, f.s, "SELECT count(*) FROM audit_events WHERE action='account.link.self' AND actor_uuid=?", alice) != 1 {
		t.Fatal("self link not audited")
	}
	// Linking an account already owned by the caller changes nothing.
	if w := linkRequest(f, token, "bob", serviceFixturePassword); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	data := responseData(t, apiRequest(f.a, "GET", "/api/account/service-links", token, nil, nil))
	links := data["links"].([]any)
	if len(links) != 2 || data["service_sign_in"] != true || len(data["servers"].([]any)) != 1 {
		t.Fatal("links", data)
	}
	for _, raw := range links {
		link := raw.(map[string]any)
		if link["server_name"] != "Living Room" || link["server_type"] != "jellyfin" || link["can_unlink"] != true {
			t.Fatal("link entry", link)
		}
	}
}

func TestSelfLinkOwnedByOther(t *testing.T) {
	f := newServiceLoginFixture(t)
	seedExternalService(t, f.s, f.server, aliceJellyfinID)
	bob := seedExternalService(t, f.s, f.server, "b0b")
	_, member := passwordMember(t, f, "member")
	if _, err := f.s.writer.Exec("INSERT INTO service_links(user_uuid,service_uuid,link_kind,created_at) VALUES(?,?,'owner',?)", member, bob, utcTimestamp(time.Now())); err != nil {
		t.Fatal(err)
	}
	token, _ := signInAsAlice(t, f)
	if w := linkRequest(f, token, "bob", serviceFixturePassword); w.Code != 409 || errorCode(t, w.Body.String()) != "SERVICE_ACCOUNT_CLAIMED" {
		t.Fatal(w.Code, w.Body.String())
	}
	if countRows(t, f.s, "SELECT count(*) FROM service_links WHERE service_uuid=? AND user_uuid=?", bob, member) != 1 {
		t.Fatal("another account's link changed")
	}
}

func TestSelfLinkRequiresSwitch(t *testing.T) {
	f := newServiceLoginFixture(t)
	seedExternalService(t, f.s, f.server, "b0b")
	token, _ := passwordMember(t, f, "member")
	setSignInSwitches(t, f.s, false, false)
	if w := linkRequest(f, token, "bob", serviceFixturePassword); w.Code != 409 || errorCode(t, w.Body.String()) != "SERVICE_SIGN_IN_DISABLED" || f.up.logins.Load() != 0 {
		t.Fatal(w.Code, w.Body.String())
	}
}

func TestSelfUnlinkKeepsASignInMethod(t *testing.T) {
	f := newServiceLoginFixture(t)
	aliceService := seedExternalService(t, f.s, f.server, aliceJellyfinID)
	bob := seedExternalService(t, f.s, f.server, "b0b")
	token, _ := signInAsAlice(t, f)
	if w := apiRequest(f.a, "DELETE", "/api/account/service-links/"+aliceService, token, nil, nil); w.Code != 409 || errorCode(t, w.Body.String()) != "LAST_SIGN_IN_METHOD" {
		t.Fatal("unlinked the only way to sign in", w.Code, w.Body.String())
	}
	data := responseData(t, apiRequest(f.a, "GET", "/api/account/service-links", token, nil, nil))
	if data["links"].([]any)[0].(map[string]any)["can_unlink"] != false {
		t.Fatal("the only sign-in method offered for unlinking", data)
	}
	if w := linkRequest(f, token, "bob", serviceFixturePassword); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := apiRequest(f.a, "DELETE", "/api/account/service-links/"+bob, token, nil, nil); w.Code != 204 {
		t.Fatal(w.Code, w.Body.String())
	}
	// Another account's link cannot be removed through this route.
	other := seedExternalService(t, f.s, f.server, "someone")
	_, member := passwordMember(t, f, "member")
	if _, err := f.s.writer.Exec("INSERT INTO service_links(user_uuid,service_uuid,link_kind,created_at) VALUES(?,?,'owner',?)", member, other, utcTimestamp(time.Now())); err != nil {
		t.Fatal(err)
	}
	if w := apiRequest(f.a, "DELETE", "/api/account/service-links/"+other, token, nil, nil); w.Code != 404 {
		t.Fatal("removed another account's link", w.Code)
	}
}

func TestSelfUnlinkEndsThatServiceSession(t *testing.T) {
	f := newServiceLoginFixture(t)
	seedExternalService(t, f.s, f.server, aliceJellyfinID)
	bob := seedExternalService(t, f.s, f.server, "b0b")
	token, alice := signInAsAlice(t, f)
	if w := linkRequest(f, token, "bob", serviceFixturePassword); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	w := serviceSignIn(f.a, f.server, "bob", serviceFixturePassword)
	if w.Code != 200 || responseData(t, w)["user"].(map[string]any)["uuid"] != alice {
		t.Fatal("bob's login should reach alice's account", w.Body.String())
	}
	bobSession := responseData(t, w)["access_token"].(string)
	if w := apiRequest(f.a, "DELETE", "/api/account/service-links/"+bob, token, nil, nil); w.Code != 204 {
		t.Fatal(w.Code, w.Body.String())
	}
	if _, err := f.s.Authenticate(t.Context(), bobSession); err == nil {
		t.Fatal("a session signed in through an unlinked account survived")
	}
	if _, err := f.s.Authenticate(t.Context(), token); err != nil {
		t.Fatal("the session signed in through alice ended", err)
	}
}

func initialCredentials(f serviceLoginFixture, token string, body map[string]any) *httptest.ResponseRecorder {
	return apiRequest(f.a, "POST", "/api/account/initial-credentials", token, body, nil)
}

func TestInitialCredentialsRequiresVerification(t *testing.T) {
	f := newServiceLoginFixture(t)
	seedExternalService(t, f.s, f.server, aliceJellyfinID)
	bob := seedExternalService(t, f.s, f.server, "b0b")
	_, member := passwordMember(t, f, "member")
	if _, err := f.s.writer.Exec("INSERT INTO service_links(user_uuid,service_uuid,link_kind,created_at) VALUES(?,?,'owner',?)", member, bob, utcTimestamp(time.Now())); err != nil {
		t.Fatal(err)
	}
	token, alice := signInAsAlice(t, f)
	if data := responseData(t, apiRequest(f.a, "GET", "/api/account/profile", token, nil, nil)); data["initial_credentials_available"] != true {
		t.Fatal("profile capability", data)
	}
	base := map[string]any{"username": "alice-local", "password": "a-strong-local-password"}
	if w := initialCredentials(f, token, base); w.Code != 403 || errorCode(t, w.Body.String()) != "VERIFICATION_REQUIRED" {
		t.Fatal("set a password without verification", w.Code, w.Body.String())
	}
	withLogin := func(username, password string) map[string]any {
		body := map[string]any{"username": "alice-local", "password": "a-strong-local-password", "verification": map[string]any{"server_id": f.server, "username": username, "password": password}}
		return body
	}
	if w := initialCredentials(f, token, withLogin("alice", "wrong-password")); w.Code != 401 {
		t.Fatal("wrong verification password", w.Code, w.Body.String())
	}
	if w := initialCredentials(f, token, withLogin("bob", serviceFixturePassword)); w.Code != 403 || errorCode(t, w.Body.String()) != "VERIFICATION_REQUIRED" {
		t.Fatal("verified with another account's login", w.Code, w.Body.String())
	}
	if w := initialCredentials(f, token, map[string]any{"username": "alice-local", "password": "short", "verification": map[string]any{"server_id": f.server, "username": "alice", "password": serviceFixturePassword}}); w.Code != 400 {
		t.Fatal("short password accepted", w.Code)
	}
	w := initialCredentials(f, token, withLogin("alice", serviceFixturePassword))
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	data := responseData(t, w)
	if data["user"].(map[string]any)["has_password"] != true || data["capabilities"].(map[string]any)["can_set_initial_credentials"] != false {
		t.Fatal("response", data)
	}
	if w := apiRequest(f.a, "POST", "/api/auth/login", "", map[string]any{"username": "alice-local", "password": "a-strong-local-password"}, nil); w.Code != 200 || responseData(t, w)["user"].(map[string]any)["uuid"] != alice {
		t.Fatal("the new password does not sign in", w.Code, w.Body.String())
	}
	if countRows(t, f.s, "SELECT count(*) FROM audit_events WHERE action='account.credentials.initial' AND actor_uuid=?", alice) != 1 {
		t.Fatal("not audited")
	}
}

func TestInitialCredentialsOnlyWhenPasswordless(t *testing.T) {
	f := newServiceLoginFixture(t)
	token, _ := passwordMember(t, f, "member")
	if w := initialCredentials(f, token, map[string]any{"username": "other-name", "password": "a-strong-local-password"}); w.Code != 409 || errorCode(t, w.Body.String()) != "PASSWORD_ALREADY_SET" {
		t.Fatal(w.Code, w.Body.String())
	}
}

func TestInitialCredentialsUsernameUnique(t *testing.T) {
	f := newServiceLoginFixture(t)
	seedExternalService(t, f.s, f.server, aliceJellyfinID)
	passwordMember(t, f, "member")
	token, _ := signInAsAlice(t, f)
	body := map[string]any{"username": "MEMBER", "password": "a-strong-local-password", "verification": map[string]any{"server_id": f.server, "username": "alice", "password": serviceFixturePassword}}
	if w := initialCredentials(f, token, body); w.Code != 409 || errorCode(t, w.Body.String()) != "USERNAME_UNAVAILABLE" {
		t.Fatal(w.Code, w.Body.String())
	}
}

func TestInitialCredentialsPlexFreshSession(t *testing.T) {
	f := newServiceLoginFixture(t)
	user := newUUID()
	now := utcTimestamp(time.Now())
	for _, statement := range []string{
		"INSERT INTO identities(uuid,kind) VALUES('" + user + "','local')",
		"INSERT INTO user_accounts(uuid,kind,created_at,updated_at) VALUES('" + user + "','local','" + now + "','" + now + "')",
		"UPDATE provider_settings SET enabled=1 WHERE provider_id='plex'",
		"INSERT INTO plex_connections(id,owner_uuid,account_id,username,secret,status,created_at,verified_at) VALUES('conn','" + user + "','2','plexuser',x'00','active','" + now + "','" + now + "')",
	} {
		if _, err := f.s.writer.Exec(statement); err != nil {
			t.Fatal(statement, err)
		}
	}
	tokens := issueOriginSession(t, f.s, user, sessionOrigin{Kind: "plex_connection", PlexConnection: "conn"})
	body := map[string]any{"username": "plex-local", "password": "a-strong-local-password"}
	if _, err := f.s.writer.Exec("UPDATE app_sessions SET created_at=? WHERE user_uuid=?", utcTimestamp(time.Now().Add(-10*time.Minute)), user); err != nil {
		t.Fatal(err)
	}
	if w := initialCredentials(f, tokens.Access, body); w.Code != 403 || errorCode(t, w.Body.String()) != "VERIFICATION_REQUIRED" {
		t.Fatal("a stale Plex session set a password", w.Code, w.Body.String())
	}
	if _, err := f.s.writer.Exec("UPDATE app_sessions SET created_at=? WHERE user_uuid=?", now, user); err != nil {
		t.Fatal(err)
	}
	if w := initialCredentials(f, tokens.Access, body); w.Code != 200 {
		t.Fatal("a fresh Plex session could not set a password", w.Code, w.Body.String())
	}
}
