package main

import (
	"net/http"
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
	return a, s, token, f
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
	a, s, token, _ := plexLoginFixture(t, "")
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
	if data["status"] != "signed_in" || data["user"].(map[string]any)["user_type"] != "owner" || strings.Contains(w.Body.String(), plexFixtureToken) {
		t.Fatal("unexpected sign-in result", w.Body.String())
	}
	var refresh *http.Cookie
	for _, c := range w.Result().Cookies() {
		if c.Name == "mum_refresh" {
			refresh = c
		}
	}
	if refresh == nil || !refresh.HttpOnly || time.Until(refresh.Expires) < 29*24*time.Hour {
		t.Fatal("remembered session cookie missing", refresh)
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
	a, s, token, _ := plexLoginFixture(t, "")
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
