package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const serviceFixturePassword = "fixture-user-password"

// serviceLoginUpstream is a Jellyfin server that knows one user per name;
// every user's password is serviceFixturePassword.
type serviceLoginUpstream struct {
	server *httptest.Server
	logins atomic.Int32
	users  map[string]string // username -> Jellyfin user ID
	before func()            // runs before a login is answered
}

func newServiceLoginUpstream(t *testing.T, users map[string]string) *serviceLoginUpstream {
	t.Helper()
	u := &serviceLoginUpstream{users: users}
	u.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/System/Info":
			_ = json.NewEncoder(w).Encode(map[string]string{"ServerName": "Fixture", "Version": "10.11"})
		case "/Users/AuthenticateByName":
			u.logins.Add(1)
			if u.before != nil {
				u.before()
			}
			var body map[string]string
			_ = json.NewDecoder(r.Body).Decode(&body)
			id, known := u.users[body["Username"]]
			if !known || body["Pw"] != serviceFixturePassword {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"User": map[string]string{"Id": id, "Name": body["Username"]}, "AccessToken": "user-token"})
		case "/Sessions/Logout":
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(u.server.Close)
	return u
}

type serviceLoginFixture struct {
	a       *App
	s       *Store
	owner   string
	ownerID string
	up      *serviceLoginUpstream
	server  int64
}

const aliceJellyfinID = "5F0E6C4B-3C1D-4A55-9F3A-0123456789AB"

func newServiceLoginFixture(t *testing.T) serviceLoginFixture {
	t.Helper()
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	owner, err := s.Authenticate(t.Context(), token)
	if err != nil {
		t.Fatal(err)
	}
	up := newServiceLoginUpstream(t, map[string]string{"alice": "5f0e6c4b3c1d4a559f3a0123456789ab", "bob": "b0b", "ghost": "not-synced"})
	a.ProviderHTTP = up.server.Client()
	server := addServiceLoginServer(t, s, up, "Living Room")
	setSignInSwitches(t, s, true, false)
	return serviceLoginFixture{a: a, s: s, owner: token, ownerID: owner.UUID, up: up, server: server}
}

func addServiceLoginServer(t *testing.T, s *Store, up *serviceLoginUpstream, name string) int64 {
	t.Helper()
	if _, err := s.writer.Exec("UPDATE provider_settings SET enabled=1 WHERE provider_id='jellyfin'"); err != nil {
		t.Fatal(err)
	}
	r, err := s.writer.Exec(`INSERT INTO media_servers(server_nickname,service_type,url,api_key) VALUES(?,'jellyfin',?,'fixture-secret')`, name, up.server.URL)
	if err != nil {
		t.Fatal(err)
	}
	id, _ := r.LastInsertId()
	return id
}

func seedExternalService(t *testing.T, s *Store, server int64, external string) string {
	t.Helper()
	id := newUUID()
	if _, err := s.writer.Exec(`INSERT INTO identities(uuid,kind) VALUES(?,'service')`, id); err != nil {
		t.Fatal(err)
	}
	if _, err := s.writer.Exec(`INSERT INTO service_accounts(uuid,server_id,external_user_id,external_username,created_at,updated_at) VALUES(?,?,?,?,?,?)`,
		id, server, external, "synced", utcTimestamp(time.Now()), utcTimestamp(time.Now())); err != nil {
		t.Fatal(err)
	}
	return id
}

func serviceSignIn(a *App, server int64, username, password string) *httptest.ResponseRecorder {
	return apiRequest(a, "POST", "/api/auth/service", "", map[string]any{"server_id": server, "username": username, "password": password, "remember": false}, nil)
}

func errorCode(t *testing.T, body string) string {
	t.Helper()
	var envelope struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	_ = json.Unmarshal([]byte(body), &envelope)
	return envelope.Error.Code
}

func TestServiceSignInCreatesAccountOnFirstSignIn(t *testing.T) {
	f := newServiceLoginFixture(t)
	service := seedExternalService(t, f.s, f.server, aliceJellyfinID)
	w := serviceSignIn(f.a, f.server, "alice", serviceFixturePassword)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	data := responseData(t, w)
	user := data["user"].(map[string]any)
	if user["has_admin_access"] != false || user["user_type"] != "local" || len(data["access_token"].(string)) != 43 {
		t.Fatal("unexpected session", data)
	}
	var owner, origin, via string
	var hash, username any
	if err := f.s.reader.QueryRow("SELECT l.user_uuid,u.password_hash,u.local_username FROM service_links l JOIN user_accounts u ON u.uuid=l.user_uuid WHERE l.service_uuid=? AND l.link_kind='owner'", service).Scan(&owner, &hash, &username); err != nil {
		t.Fatal("no owner link created", err)
	}
	if owner != user["uuid"] || hash != nil || username != nil {
		t.Fatal("created account", owner, hash, username)
	}
	if err := f.s.reader.QueryRow("SELECT sign_in_origin,via_service_uuid FROM app_sessions WHERE user_uuid=?", owner).Scan(&origin, &via); err != nil || origin != "service" || via != service {
		t.Fatal("session origin", origin, via, err)
	}
	if n := countRows(t, f.s, "SELECT count(*) FROM audit_events WHERE action='auth.account.created.service' AND actor_uuid=?", owner); n != 1 {
		t.Fatal("account creation not audited", n)
	}
	// A second sign-in reaches the same account.
	if w := serviceSignIn(f.a, f.server, "alice", serviceFixturePassword); w.Code != 200 || responseData(t, w)["user"].(map[string]any)["uuid"] != owner {
		t.Fatal("second sign-in", w.Code, w.Body.String())
	}
	if n := countRows(t, f.s, "SELECT count(*) FROM user_accounts WHERE kind='local'"); n != 1 {
		t.Fatal("accounts created", n)
	}
	if n := countRows(t, f.s, "SELECT count(*) FROM audit_events WHERE action='auth.login.service'"); n != 2 {
		t.Fatal("sign-ins not audited", n)
	}
}

func TestServiceSignInUsesExistingOwner(t *testing.T) {
	f := newServiceLoginFixture(t)
	service := seedExternalService(t, f.s, f.server, "5f0e6c4b3c1d4a559f3a0123456789ab")
	member, err := f.s.CreateAccount(t.Context(), f.ownerID, "member", "fixture-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.writer.Exec("INSERT INTO service_links(user_uuid,service_uuid,link_kind,created_at) VALUES(?,?,'owner',?)", member, service, utcTimestamp(time.Now())); err != nil {
		t.Fatal(err)
	}
	w := serviceSignIn(f.a, f.server, "alice", serviceFixturePassword)
	if w.Code != 200 || responseData(t, w)["user"].(map[string]any)["uuid"] != member {
		t.Fatal(w.Code, w.Body.String())
	}
}

func TestServiceSignInDisabled(t *testing.T) {
	f := newServiceLoginFixture(t)
	seedExternalService(t, f.s, f.server, aliceJellyfinID)
	setSignInSwitches(t, f.s, false, false)
	w := serviceSignIn(f.a, f.server, "alice", serviceFixturePassword)
	if w.Code != 409 || errorCode(t, w.Body.String()) != "SERVICE_SIGN_IN_DISABLED" || f.up.logins.Load() != 0 {
		t.Fatal("sign-in while off", w.Code, w.Body.String(), f.up.logins.Load())
	}
	setSignInSwitches(t, f.s, true, false)
	if _, err := f.s.writer.Exec("UPDATE media_servers SET is_active=0 WHERE id=?", f.server); err != nil {
		t.Fatal(err)
	}
	if w := serviceSignIn(f.a, f.server, "alice", serviceFixturePassword); w.Code != 404 || f.up.logins.Load() != 0 {
		t.Fatal("sign-in to a disabled server", w.Code, w.Body.String())
	}
}

func TestServiceSignInWrongPasswordGeneric(t *testing.T) {
	f := newServiceLoginFixture(t)
	seedExternalService(t, f.s, f.server, aliceJellyfinID)
	wrong := serviceSignIn(f.a, f.server, "alice", "not-the-password")
	unknown := serviceSignIn(f.a, f.server, "nobody", serviceFixturePassword)
	for _, w := range []*httptest.ResponseRecorder{wrong, unknown} {
		if w.Code != 401 || errorCode(t, w.Body.String()) != "SERVICE_SIGN_IN_FAILED" {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	if wrong.Body.String() != unknown.Body.String() {
		t.Fatal("wrong password and unknown user must answer identically")
	}
}

func TestServiceSignInUnknownAndInactive(t *testing.T) {
	f := newServiceLoginFixture(t)
	if w := serviceSignIn(f.a, f.server, "ghost", serviceFixturePassword); w.Code != 403 || errorCode(t, w.Body.String()) != "SERVICE_ACCOUNT_NOT_IN_MUM" {
		t.Fatal("unsynced account", w.Code, w.Body.String())
	}
	for _, change := range []string{"UPDATE service_accounts SET is_active=0 WHERE uuid=?", "UPDATE service_accounts SET removed_at='2026-01-01T00:00:00Z' WHERE uuid=?"} {
		service := seedExternalService(t, f.s, f.server, "b0b")
		if _, err := f.s.writer.Exec(change, service); err != nil {
			t.Fatal(err)
		}
		if w := serviceSignIn(f.a, f.server, "bob", serviceFixturePassword); w.Code != 403 || errorCode(t, w.Body.String()) != "SERVICE_ACCOUNT_INACTIVE" {
			t.Fatal(change, w.Code, w.Body.String())
		}
		for _, statement := range []string{"DELETE FROM service_accounts WHERE uuid=?", "DELETE FROM identities WHERE uuid=?"} {
			if _, err := f.s.writer.Exec(statement, service); err != nil {
				t.Fatal(err)
			}
		}
	}
	if n := countRows(t, f.s, "SELECT count(*) FROM user_accounts WHERE kind='local'"); n != 0 {
		t.Fatal("accounts created for refused sign-ins", n)
	}
	// A disabled MUM account is refused even with a valid server login.
	service := seedExternalService(t, f.s, f.server, aliceJellyfinID)
	member, _ := f.s.CreateAccount(t.Context(), f.ownerID, "member", "fixture-hash", false)
	if _, err := f.s.writer.Exec("INSERT INTO service_links(user_uuid,service_uuid,link_kind,created_at) VALUES(?,?,'owner',?)", member, service, utcTimestamp(time.Now())); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.writer.Exec("UPDATE user_accounts SET is_active=0 WHERE uuid=?", member); err != nil {
		t.Fatal(err)
	}
	if w := serviceSignIn(f.a, f.server, "alice", serviceFixturePassword); w.Code != 403 || errorCode(t, w.Body.String()) != "ACCOUNT_UNAVAILABLE" {
		t.Fatal("disabled account", w.Code, w.Body.String())
	}
}

func TestServiceSignInAdminRule(t *testing.T) {
	f := newServiceLoginFixture(t)
	service := seedExternalService(t, f.s, f.server, aliceJellyfinID)
	member, _ := f.s.CreateAccount(t.Context(), f.ownerID, "member", "fixture-hash", false)
	if _, err := f.s.writer.Exec("INSERT INTO service_links(user_uuid,service_uuid,link_kind,created_at) VALUES(?,?,'owner',?)", member, service, utcTimestamp(time.Now())); err != nil {
		t.Fatal(err)
	}
	grantAdministrator(t, f.s, member)
	if w := serviceSignIn(f.a, f.server, "alice", serviceFixturePassword); w.Code != 403 || errorCode(t, w.Body.String()) != "ADMIN_PASSWORD_REQUIRED" {
		t.Fatal("administrator signed in while admins are off", w.Code, w.Body.String())
	}
	setSignInSwitches(t, f.s, true, true)
	if w := serviceSignIn(f.a, f.server, "alice", serviceFixturePassword); w.Code != 200 {
		t.Fatal("administrator refused while admins are on", w.Code, w.Body.String())
	}
	ownerService := seedExternalService(t, f.s, f.server, "b0b")
	if _, err := f.s.writer.Exec("INSERT INTO service_links(user_uuid,service_uuid,link_kind,created_at) VALUES(?,?,'owner',?)", f.ownerID, ownerService, utcTimestamp(time.Now())); err != nil {
		t.Fatal(err)
	}
	if w := serviceSignIn(f.a, f.server, "bob", serviceFixturePassword); w.Code != 403 || errorCode(t, w.Body.String()) != "ADMIN_PASSWORD_REQUIRED" {
		t.Fatal("owner signed in through a server login", w.Code, w.Body.String())
	}
}

func TestServiceSignInSwitchOffMidFlight(t *testing.T) {
	f := newServiceLoginFixture(t)
	seedExternalService(t, f.s, f.server, aliceJellyfinID)
	f.up.before = func() { setSignInSwitches(t, f.s, false, false) }
	if w := serviceSignIn(f.a, f.server, "alice", serviceFixturePassword); w.Code != 409 || errorCode(t, w.Body.String()) != "SERVICE_SIGN_IN_DISABLED" {
		t.Fatal(w.Code, w.Body.String())
	}
	if n := countRows(t, f.s, "SELECT count(*) FROM user_accounts WHERE kind='local'"); n != 0 {
		t.Fatal("account created after the switch turned off", n)
	}
}

func TestServiceSignInConcurrentFirstSignIns(t *testing.T) {
	f := newServiceLoginFixture(t)
	seedExternalService(t, f.s, f.server, aliceJellyfinID)
	var wg sync.WaitGroup
	codes := make([]int, 4)
	for i := range codes {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			codes[i] = serviceSignIn(f.a, f.server, "alice", serviceFixturePassword).Code
		}(i)
	}
	wg.Wait()
	for _, code := range codes {
		if code != 200 {
			t.Fatal("concurrent sign-in failed", codes)
		}
	}
	if n := countRows(t, f.s, "SELECT count(*) FROM user_accounts WHERE kind='local'"); n != 1 {
		t.Fatal("concurrent first sign-ins created accounts", n)
	}
}

func TestServiceSignInSameIDOnTwoServers(t *testing.T) {
	f := newServiceLoginFixture(t)
	second := newServiceLoginUpstream(t, map[string]string{"alice": "5f0e6c4b3c1d4a559f3a0123456789ab"})
	other := addServiceLoginServer(t, f.s, second, "Bedroom")
	onFirst := seedExternalService(t, f.s, f.server, aliceJellyfinID)
	onSecond := seedExternalService(t, f.s, other, aliceJellyfinID)
	// Two separate httptest servers need one client that reaches both.
	f.a.ProviderHTTP = &http.Client{}
	first := responseData(t, serviceSignIn(f.a, f.server, "alice", serviceFixturePassword))["user"].(map[string]any)["uuid"]
	w := serviceSignIn(f.a, other, "alice", serviceFixturePassword)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if responseData(t, w)["user"].(map[string]any)["uuid"] == first {
		t.Fatal("a login on one server resolved an account through another server")
	}
	if countRows(t, f.s, "SELECT count(*) FROM service_links WHERE service_uuid IN (?,?) AND link_kind='owner'", onFirst, onSecond) != 2 {
		t.Fatal("each server account should have its own owner")
	}
}

func TestServiceSignInRateLimits(t *testing.T) {
	f := newServiceLoginFixture(t)
	for i, name := range []string{"Alice", " alice", "ALICE ", "alice", "aLiCe"} {
		if w := serviceSignIn(f.a, f.server, name, "wrong-password"); w.Code != 401 {
			t.Fatal(i, w.Code, w.Body.String())
		}
	}
	w := serviceSignIn(f.a, f.server, "alice", serviceFixturePassword)
	if w.Code != 429 || errorCode(t, w.Body.String()) != "SERVICE_SIGN_IN_LIMIT" || w.Header().Get("Retry-After") == "" {
		t.Fatal("sixth attempt for one username", w.Code, w.Body.String())
	}
	if f.up.logins.Load() != 5 {
		t.Fatal("a limited attempt reached the server", f.up.logins.Load())
	}
	// Other usernames from the same address are limited at 10 per minute.
	for i := 0; i < 5; i++ {
		serviceSignIn(f.a, f.server, "user"+string(rune('a'+i)), "wrong-password")
	}
	if w := serviceSignIn(f.a, f.server, "another", "wrong-password"); w.Code != 429 {
		t.Fatal("eleventh attempt from one address", w.Code)
	}
}

func TestServiceSignInRejectsOversizedBody(t *testing.T) {
	f := newServiceLoginFixture(t)
	for _, body := range []map[string]any{
		{"server_id": f.server, "username": strings.Repeat("a", 256), "password": "pw", "remember": false},
		{"server_id": f.server, "username": "alice", "password": strings.Repeat("p", 1025), "remember": false},
		{"server_id": f.server, "username": "alice", "password": "", "remember": false},
		{"server_id": f.server, "username": "  ", "password": "pw", "remember": false},
		{"server_id": 0, "username": "alice", "password": "pw", "remember": false},
		{"server_id": f.server, "username": "alice", "password": "pw", "remember": false, "extra": true},
	} {
		if w := apiRequest(f.a, "POST", "/api/auth/service", "", body, nil); w.Code != 400 {
			t.Fatal("malformed body accepted", body, w.Code)
		}
	}
	if f.up.logins.Load() != 0 {
		t.Fatal("a malformed request reached the server")
	}
}

func TestServiceSignInNeverLeaksPassword(t *testing.T) {
	f := newServiceLoginFixture(t)
	seedExternalService(t, f.s, f.server, aliceJellyfinID)
	responses := serviceSignIn(f.a, f.server, "alice", serviceFixturePassword).Body.String() + serviceSignIn(f.a, f.server, "alice", "a-wrong-secret-value").Body.String()
	var audit string
	if err := f.s.reader.QueryRow("SELECT coalesce(group_concat(coalesce(details,''),'|'),'') FROM audit_events").Scan(&audit); err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{serviceFixturePassword, "a-wrong-secret-value", "user-token", "fixture-secret"} {
		if strings.Contains(responses, secret) || strings.Contains(audit, secret) {
			t.Fatal("secret leaked", secret)
		}
	}
	if n := countRows(t, f.s, "SELECT count(*) FROM service_login_attempts WHERE username_hash='alice' OR source_hash LIKE '%.%'"); n != 0 {
		t.Fatal("attempts must keep only hashes")
	}
}

func TestAuthMethods(t *testing.T) {
	f := newServiceLoginFixture(t)
	if _, err := f.s.writer.Exec(`INSERT INTO media_servers(server_nickname,service_type,url,api_key) VALUES('Comics','komga','http://komga.invalid','k')`); err != nil {
		t.Fatal(err)
	}
	data := responseData(t, apiRequest(f.a, "GET", "/api/auth/methods", "", nil, nil))
	servers := data["servers"].([]any)
	if data["service_sign_in"] != true || data["plex"] != false || len(servers) != 1 {
		t.Fatal("methods", data)
	}
	first := servers[0].(map[string]any)
	if first["id"] != float64(f.server) || first["name"] != "Living Room" || first["type"] != "jellyfin" || len(first) != 3 {
		t.Fatal("server entry must carry only id, name and type", first)
	}
	setSignInSwitches(t, f.s, false, false)
	data = responseData(t, apiRequest(f.a, "GET", "/api/auth/methods", "", nil, nil))
	if data["service_sign_in"] != false || data["plex"] != false || len(data["servers"].([]any)) != 0 {
		t.Fatal("methods while off", data)
	}
}

func TestServiceSignInWaitsForAnEditOnThatServer(t *testing.T) {
	f := newServiceLoginFixture(t)
	seedExternalService(t, f.s, f.server, aliceJellyfinID)
	// An administrator's edit holds the server: no account is created or
	// linked under it.
	for _, statement := range []string{"PRAGMA foreign_keys=OFF", "INSERT INTO edit_source_locks(server_id,operation_id,operation_token) VALUES(1,'edit','token')", "PRAGMA foreign_keys=ON"} {
		if _, err := f.s.writer.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if w := serviceSignIn(f.a, f.server, "alice", serviceFixturePassword); w.Code != 409 || errorCode(t, w.Body.String()) != "ACCOUNT_CHANGE_IN_PROGRESS" {
		t.Fatal(w.Code, w.Body.String())
	}
	if n := countRows(t, f.s, "SELECT count(*) FROM user_accounts WHERE kind='local'"); n != 0 {
		t.Fatal("account created during an edit", n)
	}
}
