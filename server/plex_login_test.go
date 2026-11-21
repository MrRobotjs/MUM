package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// plexLoginFixture is an owner with the Plex provider enabled and a fake
// plex.tv that verifies Plex account 2.
func plexLoginFixture(t *testing.T, mode string) (*App, *Store, string, *plexAuthFixture) {
	t.Helper()
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	f := newPlexAuthFixture(t, mode)
	a.ProviderHTTP = f.client
	if w := apiRequest(a, "POST", "/api/providers/plex/enable", token, map[string]any{}, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	setSignInSwitches(t, s, true, false)
	return a, s, token, f
}

// plexMemberToken signs in a regular MUM account with its password, for tests
// that link Plex to an account other than the owner.
func plexMemberToken(t *testing.T, a *App, s *Store, owner string) (string, string) {
	t.Helper()
	ownerPrincipal, err := s.Authenticate(t.Context(), owner)
	if err != nil {
		t.Fatal(err)
	}
	hash, err := hashPassword("a-strong-member-password")
	if err != nil {
		t.Fatal(err)
	}
	member, err := s.CreateAccount(t.Context(), ownerPrincipal.UUID, "plex-member", hash, false)
	if err != nil {
		t.Fatal(err)
	}
	w := apiRequest(a, "POST", "/api/auth/login", "", map[string]any{"username": "plex-member", "password": "a-strong-member-password"}, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	return responseData(t, w)["access_token"].(string), member
}

// linkPlexForTest links Plex account 2 to the signed-in account, as the
// account page does.
func linkPlexForTest(t *testing.T, a *App, token string) {
	t.Helper()
	id, cookie := startPlexForTest(t, a, token)
	verifyPlexForTest(t, a, token, id, cookie)
	if w := apiRequest(a, "POST", "/api/plex/authorizations/"+id+"/confirm", token, map[string]any{"expected_account_id": "2"}, cookie); w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
}

func startPlexLoginForTest(t *testing.T, a *App, remember bool) (string, *http.Cookie) {
	t.Helper()
	w := apiRequest(a, "POST", "/api/auth/plex", "", map[string]any{"remember": remember}, nil)
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	data := responseData(t, w)
	id := data["id"].(string)
	cookies := w.Result().Cookies()
	if data["status"] != "pending" || !strings.HasPrefix(data["authorization_url"].(string), "https://app.plex.tv/auth#?") || len(cookies) != 1 ||
		!cookies[0].HttpOnly || cookies[0].SameSite != http.SameSiteStrictMode || cookies[0].Path != "/api/auth/plex/"+id {
		t.Fatal("unsafe browser-bound sign-in", data, cookies)
	}
	return id, cookies[0]
}

func countRows(t *testing.T, s *Store, query string, args ...any) int {
	t.Helper()
	var n int
	if err := s.reader.QueryRow(query, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestPlexSignInSignsInTheLinkedAccountOnce(t *testing.T) {
	a, s, owner, _ := plexLoginFixture(t, "")
	token, member := plexMemberToken(t, a, s, owner)
	linkPlexForTest(t, a, token)
	sessions := countRows(t, s, "SELECT count(*) FROM app_sessions")
	id, cookie := startPlexLoginForTest(t, a, true)
	// Only the browser that started the sign-in can finish it.
	if w := apiRequest(a, "POST", "/api/auth/plex/"+id+"/poll", "", map[string]any{}, nil); w.Code != 403 {
		t.Fatal("sign-in finished without its browser cookie", w.Code)
	}
	forged := &http.Cookie{Name: cookie.Name, Value: strings.Repeat("A", 43)}
	if w := apiRequest(a, "POST", "/api/auth/plex/"+id+"/poll", "", map[string]any{}, forged); w.Code != 403 {
		t.Fatal("sign-in finished by another browser", w.Code)
	}
	w := apiRequest(a, "POST", "/api/auth/plex/"+id+"/poll", "", map[string]any{}, cookie)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	data := responseData(t, w)
	if data["status"] != "signed_in" || data["user"].(map[string]any)["uuid"] != member || strings.Contains(w.Body.String(), plexFixtureToken) {
		t.Fatal("unexpected sign-in result", w.Body.String())
	}
	var origin, connection string
	if err := s.reader.QueryRow("SELECT s.sign_in_origin,s.via_plex_connection FROM app_sessions s JOIN session_access_tokens t ON t.session_id=s.id WHERE t.token_hash=?", tokenHash(data["access_token"].(string))).Scan(&origin, &connection); err != nil || origin != "plex_connection" || connection == "" {
		t.Fatal("Plex session origin", origin, connection, err)
	}
	var refresh *http.Cookie
	for _, c := range w.Result().Cookies() {
		if c.Name == "mum_refresh" {
			refresh = c
		}
	}
	// The cookie lasts until the inactivity timeout (renewals extend it).
	if refresh == nil || !refresh.HttpOnly || time.Until(refresh.Expires) < 6*24*time.Hour || time.Until(refresh.Expires) > 8*24*time.Hour {
		t.Fatal("session cookie missing or not lasting the inactivity timeout", refresh)
	}
	// The access token works like a password session's.
	if w := apiRequest(a, "GET", "/api/auth/session", data["access_token"].(string), nil, nil); w.Code != 200 {
		t.Fatal("Plex session refused", w.Code, w.Body.String())
	}
	if countRows(t, s, "SELECT count(*) FROM app_sessions") != sessions+1 {
		t.Fatal("expected exactly one new session")
	}
	var status string
	var secret []byte
	s.reader.QueryRow("SELECT status,secret FROM plex_login_attempts WHERE id=?", id).Scan(&status, &secret)
	if status != "consumed" || secret != nil {
		t.Fatal("finished sign-in kept its secret", status)
	}
	if countRows(t, s, "SELECT count(*) FROM audit_events WHERE action='auth.login.plex' AND actor_uuid IS NOT NULL") != 1 {
		t.Fatal("Plex sign-in not audited")
	}
	// A finished sign-in cannot issue a second session.
	if w := apiRequest(a, "POST", "/api/auth/plex/"+id+"/poll", "", map[string]any{}, cookie); w.Code != 409 || countRows(t, s, "SELECT count(*) FROM app_sessions") != sessions+1 {
		t.Fatal("sign-in replayed", w.Code)
	}
}

func TestPlexSignInRefusesAnUnlinkedOrDisconnectedPlexAccount(t *testing.T) {
	a, s, owner, _ := plexLoginFixture(t, "")
	token, _ := plexMemberToken(t, a, s, owner)
	sessions := countRows(t, s, "SELECT count(*) FROM app_sessions")
	id, cookie := startPlexLoginForTest(t, a, false)
	w := apiRequest(a, "POST", "/api/auth/plex/"+id+"/poll", "", map[string]any{}, cookie)
	if w.Code != 403 || !strings.Contains(w.Body.String(), "PLEX_ACCOUNT_NOT_LINKED") {
		t.Fatal(w.Code, w.Body.String())
	}
	// Linked, then disconnected on the account page: no longer a way in.
	linkPlexForTest(t, a, token)
	var connection string
	s.reader.QueryRow("SELECT id FROM plex_connections WHERE status='active'").Scan(&connection)
	if w := apiRequest(a, "POST", "/api/plex/connections/"+connection+"/revoke", token, map[string]any{}, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	id, cookie = startPlexLoginForTest(t, a, false)
	if w := apiRequest(a, "POST", "/api/auth/plex/"+id+"/poll", "", map[string]any{}, cookie); w.Code != 403 || !strings.Contains(w.Body.String(), "PLEX_ACCOUNT_NOT_LINKED") {
		t.Fatal(w.Code, w.Body.String())
	}
	if countRows(t, s, "SELECT count(*) FROM app_sessions") != sessions {
		t.Fatal("an unlinked Plex account received a session")
	}
	if countRows(t, s, "SELECT count(*) FROM plex_login_attempts WHERE status='failed' AND secret IS NULL") != 2 {
		t.Fatal("refused sign-ins kept their secrets")
	}
}

func TestPlexSignInWaitsForApprovalAndRespectsTheProvider(t *testing.T) {
	a, _, token, f := plexLoginFixture(t, "pending")
	id, cookie := startPlexLoginForTest(t, a, false)
	w := apiRequest(a, "POST", "/api/auth/plex/"+id+"/poll", "", map[string]any{}, cookie)
	if w.Code != 200 || responseData(t, w)["status"] != "pending" {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := apiRequest(a, "POST", "/api/auth/plex/"+id+"/poll", "", map[string]any{}, cookie); w.Code != 429 {
		t.Fatal("checked again without waiting", w.Code)
	}
	// Turning the Plex provider off turns Plex sign-in off.
	if w := apiRequest(a, "POST", "/api/providers/plex/disable", token, map[string]any{}, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := apiRequest(a, "POST", "/api/auth/plex", "", map[string]any{}, nil); w.Code != 409 || !strings.Contains(w.Body.String(), "PLEX_SIGN_IN_DISABLED") {
		t.Fatal(w.Code, w.Body.String())
	}
	f.mu.Lock()
	creates := f.creates
	f.mu.Unlock()
	if creates != 1 {
		t.Fatal("a disabled provider still contacted Plex", creates)
	}
}

// plexShareServer adds an enabled Plex server with one synced user whose
// external ID is external, and returns the server and that service account.
func plexShareServer(t *testing.T, s *Store, name, external string) (int64, string) {
	t.Helper()
	r, err := s.writer.Exec(`INSERT INTO media_servers(server_nickname,service_type,url,api_key) VALUES(?,'plex','http://plex.invalid','k')`, name)
	if err != nil {
		t.Fatal(err)
	}
	server, _ := r.LastInsertId()
	return server, seedExternalService(t, s, server, external)
}

func plexSignInNow(t *testing.T, a *App) *httptest.ResponseRecorder {
	t.Helper()
	id, cookie := startPlexLoginForTest(t, a, false)
	return apiRequest(a, "POST", "/api/auth/plex/"+id+"/poll", "", map[string]any{}, cookie)
}

// A linked Plex account signs in with the switch off, as it did before media
// server sign-in existed; only synced shares need the switch.
func TestPlexSignInSharesRequireSwitch(t *testing.T) {
	a, s, owner, _ := plexLoginFixture(t, "")
	setSignInSwitches(t, s, false, false)
	plexShareServer(t, s, "Plex", "2")
	if w := plexSignInNow(t, a); w.Code != 403 || !strings.Contains(w.Body.String(), "PLEX_ACCOUNT_NOT_LINKED") {
		t.Fatal("a synced share signed in with the switch off", w.Code, w.Body.String())
	}
	if countRows(t, s, "SELECT count(*) FROM user_accounts WHERE kind='local'") != 0 {
		t.Fatal("an account was created with the switch off")
	}
	token, member := plexMemberToken(t, a, s, owner)
	linkPlexForTest(t, a, token)
	w := plexSignInNow(t, a)
	if w.Code != 200 || responseData(t, w)["user"].(map[string]any)["uuid"] != member {
		t.Fatal("linked Plex refused with the switch off", w.Code, w.Body.String())
	}
}

func TestPlexSignInMatchesSyncedShare(t *testing.T) {
	a, s, _, _ := plexLoginFixture(t, "")
	_, share := plexShareServer(t, s, "Plex One", "2")
	_, other := plexShareServer(t, s, "Plex Two", "2")
	w := plexSignInNow(t, a)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	user := responseData(t, w)["user"].(map[string]any)
	if user["user_type"] != "local" || user["has_admin_access"] != false {
		t.Fatal("created account", user)
	}
	// The verified Plex account proves both shares, so both join the account.
	if countRows(t, s, "SELECT count(*) FROM service_links WHERE user_uuid=? AND service_uuid IN (?,?) AND link_kind='owner'", user["uuid"], share, other) != 2 {
		t.Fatal("shares not linked to the new account")
	}
	var origin string
	if err := s.reader.QueryRow("SELECT sign_in_origin FROM app_sessions WHERE user_uuid=?", user["uuid"]).Scan(&origin); err != nil || origin != "service" {
		t.Fatal("origin", origin, err)
	}
	if w := plexSignInNow(t, a); w.Code != 200 || responseData(t, w)["user"].(map[string]any)["uuid"] != user["uuid"] {
		t.Fatal("second Plex sign-in reached another account", w.Body.String())
	}
}

func TestPlexSignInNeverMatchesServerOwnerID(t *testing.T) {
	a, s, _, _ := plexLoginFixture(t, "")
	plexShareServer(t, s, "Plex", plexOwnerAccountID)
	if w := plexSignInNow(t, a); w.Code != 403 || !strings.Contains(w.Body.String(), "PLEX_ACCOUNT_NOT_LINKED") {
		t.Fatal(w.Code, w.Body.String())
	}
	if countRows(t, s, "SELECT count(*) FROM user_accounts WHERE kind='local'") != 0 {
		t.Fatal("an account was created from the server owner record")
	}
}

func TestPlexSignInSharesOwnedByDifferentAccounts(t *testing.T) {
	a, s, owner, _ := plexLoginFixture(t, "")
	ownerPrincipal, _ := s.Authenticate(t.Context(), owner)
	_, first := plexShareServer(t, s, "Plex One", "2")
	_, second := plexShareServer(t, s, "Plex Two", "2")
	for i, service := range []string{first, second} {
		user, err := s.CreateAccount(t.Context(), ownerPrincipal.UUID, "holder"+string(rune('a'+i)), "fixture-hash", false)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := s.writer.Exec("INSERT INTO service_links(user_uuid,service_uuid,link_kind,created_at) VALUES(?,?,'owner',?)", user, service, utcTimestamp(time.Now())); err != nil {
			t.Fatal(err)
		}
	}
	sessions := countRows(t, s, "SELECT count(*) FROM app_sessions")
	if w := plexSignInNow(t, a); w.Code != 409 || !strings.Contains(w.Body.String(), "SERVICE_ACCOUNT_CLAIMED") {
		t.Fatal(w.Code, w.Body.String())
	}
	if countRows(t, s, "SELECT count(*) FROM app_sessions") != sessions {
		t.Fatal("an ambiguous Plex account received a session")
	}
}

// The owner's own linked Plex account keeps signing in whatever the switches
// say, as it did before media server sign-in existed.
func TestPlexSignInOwnerLinkedPlex(t *testing.T) {
	a, s, owner, _ := plexLoginFixture(t, "")
	ownerPrincipal, _ := s.Authenticate(t.Context(), owner)
	linkPlexForTest(t, a, owner)
	for _, sw := range [][2]bool{{true, false}, {false, false}, {true, true}} {
		setSignInSwitches(t, s, sw[0], sw[1])
		w := plexSignInNow(t, a)
		if w.Code != 200 || responseData(t, w)["user"].(map[string]any)["uuid"] != ownerPrincipal.UUID {
			t.Fatal("owner's linked Plex refused", sw, w.Code, w.Body.String())
		}
		if _, err := s.Authenticate(t.Context(), responseData(t, w)["access_token"].(string)); err != nil {
			t.Fatal("owner's Plex session refused", sw, err)
		}
	}
}

// An administrator reached through synced shares follows the administrator
// switch.
func TestPlexSignInSharesAdminRule(t *testing.T) {
	a, s, owner, _ := plexLoginFixture(t, "")
	ownerPrincipal, _ := s.Authenticate(t.Context(), owner)
	_, share := plexShareServer(t, s, "Plex", "2")
	admin, err := s.CreateAccount(t.Context(), ownerPrincipal.UUID, "share-admin", "fixture-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.writer.Exec("INSERT INTO service_links(user_uuid,service_uuid,link_kind,created_at) VALUES(?,?,'owner',?)", admin, share, utcTimestamp(time.Now())); err != nil {
		t.Fatal(err)
	}
	grantAdministrator(t, s, admin)
	if w := plexSignInNow(t, a); w.Code != 403 || !strings.Contains(w.Body.String(), "ADMIN_PASSWORD_REQUIRED") {
		t.Fatal("administrator signed in through a share while admins are off", w.Code, w.Body.String())
	}
	setSignInSwitches(t, s, true, true)
	if w := plexSignInNow(t, a); w.Code != 200 || responseData(t, w)["user"].(map[string]any)["uuid"] != admin {
		t.Fatal("administrator refused while admins are on", w.Code, w.Body.String())
	}
}
