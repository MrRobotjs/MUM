package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// quickConnectUpstream is a Jellyfin server with one Quick Connect request,
// approved by userID once approved is set.
type quickConnectUpstream struct {
	server   *httptest.Server
	off      atomic.Bool
	approved atomic.Bool
	userID   atomic.Value
	finishes atomic.Int32
}

func newQuickConnectUpstream(t *testing.T) *quickConnectUpstream {
	t.Helper()
	u := &quickConnectUpstream{}
	u.userID.Store(aliceJellyfinID)
	u.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/QuickConnect/Initiate":
			if u.off.Load() {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			_, _ = w.Write([]byte(`{"Authenticated":false,"Secret":"qc-fixture-secret","Code":"123456"}`))
		case "/QuickConnect/Connect":
			if r.URL.Query().Get("secret") != "qc-fixture-secret" {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"Authenticated": u.approved.Load()})
		case "/Users/AuthenticateWithQuickConnect":
			u.finishes.Add(1)
			_ = json.NewEncoder(w).Encode(map[string]any{"User": map[string]string{"Id": u.userID.Load().(string), "Name": "alice"}, "AccessToken": "user-token"})
		case "/Sessions/Logout":
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(u.server.Close)
	return u
}

type quickConnectFixture struct {
	a       *App
	s       *Store
	ownerID string
	up      *quickConnectUpstream
	server  int64
	alice   string
}

func newQuickConnectFixture(t *testing.T) quickConnectFixture {
	t.Helper()
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	owner, err := s.Authenticate(t.Context(), token)
	if err != nil {
		t.Fatal(err)
	}
	up := newQuickConnectUpstream(t)
	a.ProviderHTTP = up.server.Client()
	server := addServiceLoginServer(t, a, s, &serviceLoginUpstream{server: up.server}, "Living Room")
	setSignInSwitches(t, s, true, false)
	return quickConnectFixture{a: a, s: s, ownerID: owner.UUID, up: up, server: server, alice: seedExternalService(t, s, server, aliceJellyfinID)}
}

func startQuickConnectForTest(t *testing.T, a *App, server int64) (string, *http.Cookie, *httptest.ResponseRecorder) {
	t.Helper()
	w := apiRequest(a, "POST", "/api/auth/quick-connect", "", map[string]any{"server_id": server, "remember": false}, nil)
	if w.Code != 201 {
		return "", nil, w
	}
	data := responseData(t, w)
	cookies := w.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatal("expected one browser cookie", cookies)
	}
	return data["id"].(string), cookies[0], w
}

// pollQuickConnectNow checks the attempt, skipping the wait between checks.
func pollQuickConnectNow(a *App, id string, cookie *http.Cookie) *httptest.ResponseRecorder {
	a.quickConnect.mu.Lock()
	if attempt := a.quickConnect.byID[id]; attempt != nil {
		attempt.pollAfter = time.Time{}
	}
	a.quickConnect.mu.Unlock()
	return apiRequest(a, "POST", "/api/auth/quick-connect/"+id+"/poll", "", map[string]any{}, cookie)
}

func TestQuickConnectSignsInTheApprovingUser(t *testing.T) {
	f := newQuickConnectFixture(t)
	id, cookie, w := startQuickConnectForTest(t, f.a, f.server)
	if id == "" {
		t.Fatal(w.Code, w.Body.String())
	}
	data := responseData(t, w)
	if data["code"] != "123456" || !cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode || cookie.Path != "/api/auth/quick-connect/"+id {
		t.Fatal("unsafe or incomplete start", data, cookie)
	}
	if w := pollQuickConnectNow(f.a, id, cookie); w.Code != 200 || responseData(t, w)["status"] != "pending" {
		t.Fatal("not pending before approval", w.Code, w.Body.String())
	}
	f.up.approved.Store(true)
	w = pollQuickConnectNow(f.a, id, cookie)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	data = responseData(t, w)
	user := data["user"].(map[string]any)
	if data["status"] != "signed_in" || data["id"] != id || len(data["access_token"].(string)) != 43 || user["has_admin_access"] != false {
		t.Fatal("unexpected sign-in", w.Body.String())
	}
	if countRows(t, f.s, "SELECT count(*) FROM service_links WHERE user_uuid=? AND service_uuid=? AND link_kind='owner'", user["uuid"], f.alice) != 1 {
		t.Fatal("first Quick Connect sign-in did not create and link the account")
	}
	var origin, service string
	if err := f.s.reader.QueryRow("SELECT s.sign_in_origin,s.via_service_uuid FROM app_sessions s JOIN session_access_tokens t ON t.session_id=s.id WHERE t.token_hash=?", tokenHash(data["access_token"].(string))).Scan(&origin, &service); err != nil || origin != "service" || service != f.alice {
		t.Fatal("session origin", origin, service, err)
	}
	if countRows(t, f.s, "SELECT count(*) FROM audit_events WHERE action='auth.login.quick_connect'") != 1 {
		t.Fatal("Quick Connect sign-in not audited")
	}
	// The attempt is used up: it cannot issue a second session.
	sessions := countRows(t, f.s, "SELECT count(*) FROM app_sessions")
	if w := pollQuickConnectNow(f.a, id, cookie); w.Code != 403 || countRows(t, f.s, "SELECT count(*) FROM app_sessions") != sessions {
		t.Fatal("finished attempt replayed", w.Code)
	}
	if f.up.finishes.Load() != 1 {
		t.Fatal("expected one Quick Connect completion", f.up.finishes.Load())
	}
}

func TestQuickConnectBelongsToItsBrowser(t *testing.T) {
	f := newQuickConnectFixture(t)
	id, cookie, _ := startQuickConnectForTest(t, f.a, f.server)
	f.up.approved.Store(true)
	if w := pollQuickConnectNow(f.a, id, nil); w.Code != 403 {
		t.Fatal("finished without its browser cookie", w.Code)
	}
	forged := &http.Cookie{Name: cookie.Name, Value: strings.Repeat("A", 43)}
	if w := pollQuickConnectNow(f.a, id, forged); w.Code != 403 || errorCode(t, w.Body.String()) != "QUICK_CONNECT_EXPIRED" {
		t.Fatal("finished by another browser", w.Code, w.Body.String())
	}
	if f.up.finishes.Load() != 0 || countRows(t, f.s, "SELECT count(*) FROM app_sessions WHERE sign_in_origin='service'") != 0 {
		t.Fatal("another browser reached the server or got a session")
	}
	if w := pollQuickConnectNow(f.a, id, cookie); w.Code != 200 {
		t.Fatal("the starting browser was refused after a forged check", w.Code, w.Body.String())
	}
}

func TestQuickConnectWaitsBetweenChecksAndExpires(t *testing.T) {
	f := newQuickConnectFixture(t)
	id, cookie, _ := startQuickConnectForTest(t, f.a, f.server)
	if w := pollQuickConnectNow(f.a, id, cookie); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	w := apiRequest(f.a, "POST", "/api/auth/quick-connect/"+id+"/poll", "", map[string]any{}, cookie)
	if w.Code != 429 || errorCode(t, w.Body.String()) != "QUICK_CONNECT_WAIT" || w.Header().Get("Retry-After") == "" {
		t.Fatal("checked again too soon", w.Code, w.Body.String())
	}
	f.a.quickConnect.mu.Lock()
	f.a.quickConnect.byID[id].expires = time.Now().Add(-time.Second)
	f.a.quickConnect.mu.Unlock()
	f.up.approved.Store(true)
	if w := pollQuickConnectNow(f.a, id, cookie); w.Code != 403 || f.up.finishes.Load() != 0 {
		t.Fatal("expired attempt finished", w.Code, w.Body.String())
	}
}

func TestQuickConnectRefusals(t *testing.T) {
	t.Run("switch off", func(t *testing.T) {
		f := newQuickConnectFixture(t)
		setSignInSwitches(t, f.s, false, false)
		if _, _, w := startQuickConnectForTest(t, f.a, f.server); w.Code != 409 || errorCode(t, w.Body.String()) != "SERVICE_SIGN_IN_DISABLED" {
			t.Fatal(w.Code, w.Body.String())
		}
	})
	t.Run("not a Jellyfin server", func(t *testing.T) {
		f := newQuickConnectFixture(t)
		if _, err := f.s.writer.Exec("UPDATE provider_settings SET enabled=1 WHERE provider_id='emby'; UPDATE media_servers SET service_type='emby' WHERE id=?", f.server); err != nil {
			t.Fatal(err)
		}
		if _, _, w := startQuickConnectForTest(t, f.a, f.server); w.Code != 404 || errorCode(t, w.Body.String()) != "SERVICE_SIGN_IN_SERVER" {
			t.Fatal(w.Code, w.Body.String())
		}
	})
	t.Run("Quick Connect off on the server", func(t *testing.T) {
		f := newQuickConnectFixture(t)
		f.up.off.Store(true)
		if _, _, w := startQuickConnectForTest(t, f.a, f.server); w.Code != 409 || errorCode(t, w.Body.String()) != "QUICK_CONNECT_OFF" {
			t.Fatal(w.Code, w.Body.String())
		}
	})
	t.Run("switch turned off before approval", func(t *testing.T) {
		f := newQuickConnectFixture(t)
		id, cookie, _ := startQuickConnectForTest(t, f.a, f.server)
		f.up.approved.Store(true)
		setSignInSwitches(t, f.s, false, false)
		if w := pollQuickConnectNow(f.a, id, cookie); w.Code != 409 || f.up.finishes.Load() != 0 {
			t.Fatal("finished after the switch was turned off", w.Code, w.Body.String())
		}
	})
	t.Run("not synced", func(t *testing.T) {
		f := newQuickConnectFixture(t)
		f.up.userID.Store("not-synced")
		id, cookie, _ := startQuickConnectForTest(t, f.a, f.server)
		f.up.approved.Store(true)
		if w := pollQuickConnectNow(f.a, id, cookie); w.Code != 403 || errorCode(t, w.Body.String()) != "SERVICE_ACCOUNT_NOT_IN_MUM" {
			t.Fatal(w.Code, w.Body.String())
		}
	})
	t.Run("administrator while admins are off", func(t *testing.T) {
		f := newQuickConnectFixture(t)
		user, err := f.s.CreateAccount(t.Context(), f.ownerID, "alice-admin", "fixture-hash", false)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.s.writer.Exec("INSERT INTO service_links(user_uuid,service_uuid,link_kind,created_at) VALUES(?,?,'owner',?)", user, f.alice, utcTimestamp(time.Now())); err != nil {
			t.Fatal(err)
		}
		grantAdministrator(t, f.s, user)
		id, cookie, _ := startQuickConnectForTest(t, f.a, f.server)
		f.up.approved.Store(true)
		if w := pollQuickConnectNow(f.a, id, cookie); w.Code != 403 || errorCode(t, w.Body.String()) != "ADMIN_PASSWORD_REQUIRED" {
			t.Fatal(w.Code, w.Body.String())
		}
	})
}

func TestQuickConnectStartLimits(t *testing.T) {
	f := newQuickConnectFixture(t)
	for i := 0; i < 5; i++ {
		if id, _, w := startQuickConnectForTest(t, f.a, f.server); id == "" {
			t.Fatal(i, w.Code, w.Body.String())
		}
	}
	if _, _, w := startQuickConnectForTest(t, f.a, f.server); w.Code != 429 || errorCode(t, w.Body.String()) != "SERVICE_SIGN_IN_LIMIT" {
		t.Fatal("unlimited Quick Connect codes", w.Code, w.Body.String())
	}
}

func TestQuickConnectNeverReturnsTheServerSecret(t *testing.T) {
	f := newQuickConnectFixture(t)
	id, cookie, w := startQuickConnectForTest(t, f.a, f.server)
	bodies := w.Body.String() + cookie.Value
	bodies += pollQuickConnectNow(f.a, id, cookie).Body.String()
	f.up.approved.Store(true)
	bodies += pollQuickConnectNow(f.a, id, cookie).Body.String()
	if strings.Contains(bodies, "qc-fixture-secret") || strings.Contains(bodies, "user-token") {
		t.Fatal("a server secret reached the browser")
	}
}
