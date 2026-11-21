package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// apiRequestWith is apiRequest with a change to the request before it is served.
func apiRequestWith(a *App, method, path, token string, body any, cookie *http.Cookie, change func(*http.Request)) *httptest.ResponseRecorder {
	encoded, _ := json.Marshal(body)
	r := httptest.NewRequest(method, path, bytes.NewReader(encoded))
	r.Header.Set("Content-Type", "application/json")
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	if cookie != nil {
		r.AddCookie(cookie)
	}
	change(r)
	w := httptest.NewRecorder()
	a.ServeHTTP(w, r)
	return w
}

func sessionCookie(w interface{ Result() *http.Response }) *http.Cookie {
	for _, c := range w.Result().Cookies() {
		if c.Name == "mum_refresh" {
			return c
		}
	}
	return nil
}

// A sign-in through the API, returning its access key and refresh cookie.
func signInOwner(t *testing.T, a *App, agent string) (string, *http.Cookie) {
	t.Helper()
	r := apiRequestWith(a, "POST", "/api/auth/login", "", map[string]any{"username": "owner", "password": "a-strong-new-password", "remember": true}, nil, func(r *http.Request) { r.Header.Set("User-Agent", agent) })
	if r.Code != 200 {
		t.Fatal(r.Code, r.Body.String())
	}
	return responseData(t, r)["access_token"].(string), sessionCookie(r)
}

// A replaced refresh key presented again after the grace period ends the
// whole session; within it, a racing tab gets an access key and no cookie.
func TestRefreshKeyReuseEndsTheSession(t *testing.T) {
	a, s := testApp(t)
	bootstrapOwner(t, a)
	_, first := signInOwner(t, a, "Browser A")
	w := apiRequest(a, "POST", "/api/auth/refresh", "", nil, first)
	second := sessionCookie(w)
	if w.Code != 200 || second == nil || second.Value == first.Value {
		t.Fatal("rotation", w.Code, w.Body.String())
	}
	// Within the grace period: an access key, no new cookie, the session lives.
	w = apiRequest(a, "POST", "/api/auth/refresh", "", nil, first)
	if w.Code != 200 || sessionCookie(w) != nil {
		t.Fatal("grace renewal", w.Code, w.Body.String())
	}
	// After it: the session ends, for the thief and the owner alike.
	activityExec(t, s, "UPDATE session_refresh_history SET rotated_at=?", utcTimestamp(time.Now().Add(-2*refreshReuseGrace)))
	w = apiRequest(a, "POST", "/api/auth/refresh", "", nil, first)
	if w.Code != 401 || !strings.Contains(w.Body.String(), "SESSION_ENDED") {
		t.Fatal("reuse after the grace period", w.Code, w.Body.String())
	}
	if w := apiRequest(a, "POST", "/api/auth/refresh", "", nil, second); w.Code != 401 {
		t.Fatal("the session survived a reused key", w.Code)
	}
	var sessions, audits int
	s.reader.QueryRow("SELECT count(*) FROM app_sessions WHERE user_agent='Browser A'").Scan(&sessions)
	s.reader.QueryRow("SELECT count(*) FROM audit_events WHERE action='session.refresh_reused'").Scan(&audits)
	if sessions != 0 || audits != 1 {
		t.Fatal("sessions", sessions, "audits", audits)
	}
}

// A session ends after the inactivity timeout and, however active, after the
// maximum length, as the settings are now.
func TestSessionInactivityAndMaximumLength(t *testing.T) {
	a, s := testApp(t)
	bootstrapOwner(t, a)
	activityExec(t, s, "INSERT INTO settings(key,value) VALUES('SESSION_IDLE_DAYS','2'),('SESSION_MAX_DAYS','10') ON CONFLICT(key) DO UPDATE SET value=excluded.value")
	_, cookie := signInOwner(t, a, "Browser A")
	if until := time.Until(cookie.Expires); until < 47*time.Hour || until > 49*time.Hour {
		t.Fatal("a new sign-in lasts the inactivity timeout", until)
	}
	// Used a day ago: still in, and renewing extends it.
	activityExec(t, s, "UPDATE app_sessions SET last_used_at=?", utcTimestamp(time.Now().Add(-24*time.Hour)))
	w := apiRequest(a, "POST", "/api/auth/refresh", "", nil, cookie)
	if w.Code != 200 {
		t.Fatal("active session refused", w.Code, w.Body.String())
	}
	cookie = sessionCookie(w)
	// Unused for three days: ended.
	activityExec(t, s, "UPDATE app_sessions SET last_used_at=?", utcTimestamp(time.Now().Add(-72*time.Hour)))
	if w := apiRequest(a, "POST", "/api/auth/refresh", "", nil, cookie); w.Code != 401 {
		t.Fatal("idle session renewed", w.Code)
	}
	var expiredCount int
	if err := s.reader.QueryRow("SELECT count(*) FROM app_sessions WHERE user_agent='Browser A'").Scan(&expiredCount); err != nil || expiredCount != 0 {
		t.Fatal("expired session was not removed", expiredCount, err)
	}
	// Active, but signed in eleven days ago: ended, and its cookie never outlives the maximum.
	_, cookie = signInOwner(t, a, "Browser B")
	activityExec(t, s, "UPDATE app_sessions SET created_at=?", utcTimestamp(time.Now().Add(-9*24*time.Hour-12*time.Hour)))
	w = apiRequest(a, "POST", "/api/auth/refresh", "", nil, cookie)
	if w.Code != 200 || time.Until(sessionCookie(w).Expires) > 13*time.Hour {
		t.Fatal("near the maximum the cookie ends with it", w.Code, sessionCookie(w))
	}
	activityExec(t, s, "UPDATE app_sessions SET created_at=?", utcTimestamp(time.Now().Add(-11*24*time.Hour)))
	if w := apiRequest(a, "POST", "/api/auth/refresh", "", nil, sessionCookie(w)); w.Code != 401 {
		t.Fatal("session past its maximum renewed", w.Code)
	}
}

// People see their signed-in devices and sign one, or all others, out.
func TestAccountSessionsListAndSignOut(t *testing.T) {
	a, _ := testApp(t)
	bootstrapOwner(t, a)
	here, _ := signInOwner(t, a, "Mozilla/5.0 (Windows NT 10.0) Chrome/140.0")
	_, phoneCookie := signInOwner(t, a, "Mozilla/5.0 (iPhone) Safari/605.1")
	signInOwner(t, a, "Mozilla/5.0 (Macintosh) Firefox/140.0")
	list := func() []any {
		t.Helper()
		w := apiRequest(a, "GET", "/api/account/sessions", here, nil, nil)
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
		return responseData(t, w)["sessions"].([]any)
	}
	sessions := list()
	var current, phone string
	for _, raw := range sessions {
		s := raw.(map[string]any)
		if s["current"] == true {
			current = s["id"].(string)
		}
		if agent, _ := s["user_agent"].(string); strings.Contains(agent, "iPhone") {
			phone = s["id"].(string)
		}
		if s["sign_in"] != "password" || s["ip_address"] == nil || s["expires_at"] == nil {
			t.Fatal("session details", s)
		}
	}
	if len(sessions) < 4 || current == "" || phone == "" {
		t.Fatal("sessions", sessions)
	}
	if w := apiRequest(a, "DELETE", "/api/account/sessions/"+phone, here, nil, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := apiRequest(a, "POST", "/api/auth/refresh", "", nil, phoneCookie); w.Code != 401 {
		t.Fatal("the signed-out device still renews", w.Code)
	}
	if w := apiRequest(a, "DELETE", "/api/account/sessions/"+phone, here, nil, nil); w.Code != 404 {
		t.Fatal("ending it twice", w.Code)
	}
	if w := apiRequest(a, "POST", "/api/account/sessions/sign-out-others", here, nil, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if left := list(); len(left) != 1 || left[0].(map[string]any)["id"] != current {
		t.Fatal("only this device stays", left)
	}
	if w := apiRequest(a, "GET", "/api/account/sessions", "", nil, nil); w.Code != 401 {
		t.Fatal("anonymous list", w.Code)
	}
}

// An administrator signs a user out everywhere under the deactivation rules.
func TestAdministratorSignsUserOutEverywhere(t *testing.T) {
	a, s, ownerToken, token, user := roleReadFixture(t)
	owner, _ := s.Authenticate(t.Context(), ownerToken)
	admin, _ := lowerAdmin(t, s, ownerToken, seedServer(t, s))
	ordinary, err := s.CreateAccount(t.Context(), owner.UUID, "ordinary-user", "fixture-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{ordinary, ordinary, admin} {
		if _, err := s.issueSession(t.Context(), id, false); err != nil {
			t.Fatal(err)
		}
	}
	count := func(id string) (n int) {
		s.reader.QueryRow("SELECT count(*) FROM app_sessions WHERE user_uuid=?", id).Scan(&n)
		return
	}
	signOut := func(token, id string) int {
		return apiRequest(a, "POST", "/api/users/"+id+"/sessions/sign-out", token, nil, nil).Code
	}
	if code := signOut(token, ordinary); code != 200 || count(ordinary) != 0 {
		t.Fatal("administrator signing out a user", code, count(ordinary))
	}
	if code := signOut(token, admin); code != 403 || count(admin) == 0 {
		t.Fatal("an administrator signed out another administrator", code)
	}
	if code := signOut(token, owner.UUID); code != 403 {
		t.Fatal("the owner was signed out by an administrator", code)
	}
	if code := signOut(token, user); code != 403 {
		t.Fatal("signed themselves out through the administrator route", code)
	}
	if code := signOut(ownerToken, admin); code != 200 || count(admin) != 0 {
		t.Fatal("owner signing out an administrator", code)
	}
	if code := signOut("", ordinary); code != 401 {
		t.Fatal("anonymous", code)
	}
}

func TestOldRefreshKeyReuseEndsSession(t *testing.T) {
	a, s := testApp(t)
	bootstrapOwner(t, a)
	_, first := signInOwner(t, a, "Browser old-key")
	second := sessionCookie(apiRequest(a, "POST", "/api/auth/refresh", "", nil, first))
	third := sessionCookie(apiRequest(a, "POST", "/api/auth/refresh", "", nil, second))
	if third == nil {
		t.Fatal("second rotation failed")
	}
	activityExec(t, s, "UPDATE session_refresh_history SET rotated_at=?", utcTimestamp(time.Now().Add(-2*refreshReuseGrace)))
	if w := apiRequest(a, "POST", "/api/auth/refresh", "", nil, first); w.Code != 401 || !strings.Contains(w.Body.String(), "SESSION_ENDED") {
		t.Fatal("older reuse not detected", w.Code, w.Body.String())
	}
	if w := apiRequest(a, "POST", "/api/auth/refresh", "", nil, third); w.Code != 401 {
		t.Fatal("session survived old key reuse", w.Code)
	}
}

func TestBackgroundRenewalDoesNotExtendInactivity(t *testing.T) {
	a, s := testApp(t)
	bootstrapOwner(t, a)
	_, cookie := signInOwner(t, a, "Background fixture")
	before := utcTimestamp(time.Now().Add(-24 * time.Hour))
	activityExec(t, s, "UPDATE app_sessions SET last_used_at=? WHERE user_agent='Background fixture'", before)
	w := apiRequestWith(a, "POST", "/api/auth/refresh", "", nil, cookie, func(r *http.Request) { r.Header.Set("X-MUM-Background", "1") })
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var got string
	if err := s.reader.QueryRow("SELECT last_used_at FROM app_sessions WHERE user_agent='Background fixture'").Scan(&got); err != nil || got != before {
		t.Fatal("background activity extended session", got, err)
	}
	cookie = sessionCookie(w)
	if w = apiRequest(a, "POST", "/api/auth/refresh", "", nil, cookie); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if err := s.reader.QueryRow("SELECT last_used_at FROM app_sessions WHERE user_agent='Background fixture'").Scan(&got); err != nil || got == before {
		t.Fatal("user activity did not extend session", got, err)
	}
}

func TestShorterSessionLimitsApplyToExistingAccess(t *testing.T) {
	a, s := testApp(t)
	owner, _ := bootstrapOwner(t, a)
	victim, cookie := signInOwner(t, a, "Older fixture")
	activityExec(t, s, "UPDATE app_sessions SET last_used_at=? WHERE user_agent='Older fixture'", utcTimestamp(time.Now().Add(-48*time.Hour)))
	w := apiRequest(a, "PATCH", "/api/settings/general", owner, map[string]any{"app_name": "MUM", "public_address": "", "session_idle_days": 1, "session_max_days": 30}, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if _, err := s.Authenticate(t.Context(), victim); err == nil {
		t.Fatal("expired access remained valid")
	}
	if w = apiRequest(a, "POST", "/api/auth/refresh", "", nil, cookie); w.Code != 401 {
		t.Fatal("expired refresh remained valid", w.Code)
	}
}

func TestRememberDeviceControlsCookiePersistence(t *testing.T) {
	a, _ := testApp(t)
	bootstrapOwner(t, a)
	for _, remember := range []bool{false, true} {
		w := apiRequest(a, "POST", "/api/auth/login", "", map[string]any{"username": "owner", "password": "a-strong-new-password", "remember": remember}, nil)
		cookie := sessionCookie(w)
		if w.Code != 200 || cookie == nil || (cookie.MaxAge > 0) != remember {
			t.Fatal("login cookie", remember, w.Code, cookie)
		}
		w = apiRequest(a, "POST", "/api/auth/refresh", "", nil, cookie)
		cookie = sessionCookie(w)
		if w.Code != 200 || cookie == nil || (cookie.MaxAge > 0) != remember {
			t.Fatal("refresh cookie", remember, w.Code, cookie)
		}
	}
}

func TestExpiredSessionsAndRefreshHistoryPrunedAtSignIn(t *testing.T) {
	a, s := testApp(t)
	bootstrapOwner(t, a)
	_, cookie := signInOwner(t, a, "Expired fixture")
	if w := apiRequest(a, "POST", "/api/auth/refresh", "", nil, cookie); w.Code != 200 {
		t.Fatal(w.Code)
	}
	activityExec(t, s, "UPDATE app_sessions SET refresh_expires_at=? WHERE user_agent='Expired fixture'", utcTimestamp(time.Now().Add(-time.Hour)))
	signInOwner(t, a, "Fresh fixture")
	if countRows(t, s, "SELECT count(*) FROM app_sessions WHERE user_agent='Expired fixture'") != 0 || countRows(t, s, "SELECT count(*) FROM session_refresh_history") != 0 {
		t.Fatal("expired session or its refresh history remained")
	}
}

func TestSignOutEverywhereRevokesCurrentSession(t *testing.T) {
	a, s := testApp(t)
	bootstrapOwner(t, a)
	here, cookie := signInOwner(t, a, "Here")
	_, other := signInOwner(t, a, "Other")
	w := apiRequest(a, "POST", "/api/account/sessions/sign-out-all", here, nil, nil)
	if w.Code != 200 || responseData(t, w)["signed_out_here"] != true || sessionCookie(w) == nil || sessionCookie(w).MaxAge >= 0 {
		t.Fatal("sign-out-all confirmation", w.Code, w.Body.String(), sessionCookie(w))
	}
	if _, err := s.Authenticate(t.Context(), here); err == nil {
		t.Fatal("current access remained valid")
	}
	for _, c := range []*http.Cookie{cookie, other} {
		if w = apiRequest(a, "POST", "/api/auth/refresh", "", nil, c); w.Code != 401 {
			t.Fatal("refresh survived", w.Code)
		}
	}
}
