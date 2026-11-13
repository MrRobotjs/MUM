package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/fstest"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

func testApp(t *testing.T) (*App, *Store) {
	t.Helper()
	s := testStore(t)
	q, err := NewLogQueue(s, QueueOptions{})
	if err != nil {
		t.Fatal(err)
	}
	a, err := NewApp(s, q, fstest.MapFS{"index.html": {Data: []byte("<html>dashboard</html>")}, "assets/main.js": {Data: []byte("console.log('asset')")}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		a.CloseScheduler()
		a.CloseProvisioning()
		a.CloseCatalogue()
		a.CloseRealtime()
		if err := q.Shutdown(context.Background()); err != nil {
			t.Error(err)
		}
	})
	return a, s
}

func apiRequest(a *App, method, path, token string, body any, cookie *http.Cookie) *httptest.ResponseRecorder {
	var encoded []byte
	if body != nil {
		encoded, _ = json.Marshal(body)
	}
	r := httptest.NewRequest(method, path, bytes.NewReader(encoded))
	if body != nil {
		r.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	if cookie != nil {
		r.AddCookie(cookie)
	}
	w := httptest.NewRecorder()
	a.ServeHTTP(w, r)
	return w
}
func responseData(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var result struct {
		Data map[string]any `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return result.Data
}
func bootstrapOwner(t *testing.T, a *App) (string, *http.Cookie) {
	t.Helper()
	w := apiRequest(a, "POST", "/api/setup/account", "", map[string]string{"username": "owner", "password": "a-strong-new-password", "confirm_password": "a-strong-new-password"}, nil)
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	return responseData(t, w)["access_token"].(string), w.Result().Cookies()[0]
}

func TestFreshRuntimeAuthSetupRotationAndRevocation(t *testing.T) {
	a, s := testApp(t)
	token, cookie := bootstrapOwner(t, a)
	if !cookie.HttpOnly || cookie.Path != "/api/auth" || cookie.Name != "mum_refresh" {
		t.Fatal("refresh cookie", cookie)
	}
	for _, path := range []string{"/api/v2/auth/session", "/api/auth/jwt/login", "/socket.io/"} {
		if w := apiRequest(a, "GET", path, token, nil, nil); w.Code != 404 {
			t.Fatalf("legacy route %s accepted: %d", path, w.Code)
		}
	}
	if w := apiRequest(a, "GET", "/api/auth/session", "", nil, nil); w.Code != 401 {
		t.Fatal(w.Code)
	}
	if w := apiRequest(a, "GET", "/api/auth/session", token, nil, nil); w.Code != 200 || responseData(t, w)["user"] == nil {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := apiRequest(a, "POST", "/api/setup/app", token, map[string]string{"app_name": "MUM Go", "app_base_url": "http://localhost:5699"}, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := apiRequest(a, "POST", "/api/setup/complete", token, map[string]any{}, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := apiRequest(a, "POST", "/api/setup/app", token, map[string]string{"app_name": "reopen"}, nil); w.Code != 409 {
		t.Fatal("setup reopened", w.Code)
	}
	var successes atomic.Int64
	var wg sync.WaitGroup
	var nextToken string
	var nextCookie *http.Cookie
	var mu sync.Mutex
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			w := apiRequest(a, "POST", "/api/auth/refresh", "", nil, cookie)
			if w.Code == 200 {
				successes.Add(1)
				mu.Lock()
				nextToken = responseData(t, w)["access_token"].(string)
				nextCookie = w.Result().Cookies()[0]
				mu.Unlock()
			} else if w.Code != 401 {
				t.Errorf("refresh status %d", w.Code)
			}
		}()
	}
	wg.Wait()
	if successes.Load() != 1 {
		t.Fatal("refresh replay succeeded", successes.Load())
	}
	// Logout using the earlier access token must revoke its whole rotated session.
	if w := apiRequest(a, "POST", "/api/auth/logout", token, nil, cookie); w.Code != 200 {
		t.Fatal(w.Code)
	}
	if _, err := s.Authenticate(t.Context(), nextToken); !errors.Is(err, ErrForbidden) {
		t.Fatal("rotated access survived logout", err)
	}
	if w := apiRequest(a, "POST", "/api/auth/refresh", "", nil, nextCookie); w.Code != 401 {
		t.Fatal("rotated refresh survived logout", w.Code)
	}
	bad := apiRequest(a, "POST", "/api/auth/login", "", map[string]any{"username": "owner", "password": "wrong"}, nil)
	if bad.Code != 401 {
		t.Fatal(bad.Code)
	}
	login := apiRequest(a, "POST", "/api/auth/login", "", map[string]any{"username": "OWNER", "password": "a-strong-new-password"}, nil)
	if login.Code != 200 {
		t.Fatal(login.Code, login.Body.String())
	}
	var storedHash string
	if err := s.reader.QueryRow("SELECT password_hash FROM user_accounts WHERE local_username='owner'").Scan(&storedHash); err != nil || !strings.HasPrefix(storedHash, "mum-pbkdf2-sha256$") {
		t.Fatal(err, storedHash)
	}
	if verifyPassword("pbkdf2:sha256:600000$salt$hash", "password") {
		t.Fatal("legacy hash accepted")
	}
}

func TestOriginProtectionStaticRoutingAndIngestion(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	r := httptest.NewRequest("POST", "http://example.com/api/auth/refresh", nil)
	r.Header.Set("Origin", "https://evil.invalid")
	w := httptest.NewRecorder()
	a.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal(w.Code)
	}
	activityExec(t, s, "INSERT INTO settings(key,value,value_type) VALUES('SETUP_COMPLETE','true','string')")
	for path, want := range map[string]int{"/admin/users": 200, "/assets/main.js": 200, "/assets/missing.js": 404, "/api/missing": 404, "/ws-missing": 404} {
		w := apiRequest(a, "GET", path, "", nil, nil)
		if w.Code != want {
			t.Fatal(path, w.Code, want)
		}
	}
	if w := apiRequest(a, "POST", "/api/events", "", map[string]any{}, nil); w.Code != 401 {
		t.Fatal(w.Code)
	}
	w = apiRequest(a, "POST", "/api/events", token, map[string]any{"source": "test", "type": "entry", "payload": map[string]bool{"ok": true}}, nil)
	if w.Code != 202 || responseData(t, w)["durable"] != false {
		t.Fatal(w.Code, w.Body.String())
	}
	if err := a.queue.Shutdown(t.Context()); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := s.reader.QueryRow("SELECT count(*) FROM log_entries").Scan(&count); err != nil || count != 1 {
		t.Fatal(count, err)
	}
}

func dialClient(t *testing.T, server, token string) (*websocket.Conn, context.Context) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	t.Cleanup(cancel)
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server, "http")+"/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.CloseNow() })
	if err := wsjson.Write(ctx, c, socketCommand{Type: "authenticate", AccessToken: token}); err != nil {
		t.Fatal(err)
	}
	var reply map[string]any
	if err := wsjson.Read(ctx, c, &reply); err != nil || reply["type"] != "authenticated" {
		t.Fatal(reply, err)
	}
	return c, ctx
}

func TestNativeWebSocketScopesChatAndSessionFiltering(t *testing.T) {
	a, s := testApp(t)
	ownerToken, _ := bootstrapOwner(t, a)
	owner, err := s.Authenticate(t.Context(), ownerToken)
	if err != nil {
		t.Fatal(err)
	}
	uuid, err := s.CreateAccount(t.Context(), owner.UUID, "member", "test-only-encoded", false)
	if err != nil {
		t.Fatal(err)
	}
	tokens, err := s.issueSession(t.Context(), uuid, false)
	if err != nil {
		t.Fatal(err)
	}
	serverID := seedServer(t, s)
	service := seedService(t, s, serverID)
	if err := s.LinkServiceAccounts(t.Context(), owner.UUID, uuid, []string{service}); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(a)
	t.Cleanup(server.Close)
	c, ctx := dialClient(t, server.URL, tokens.Access)
	if err := wsjson.Write(ctx, c, socketCommand{Type: "subscribe", Channels: []string{"chat.global", "system.logs", "jellyfin.1.sessions"}}); err != nil {
		t.Fatal(err)
	}
	var subscriptions map[string]any
	if err := wsjson.Read(ctx, c, &subscriptions); err != nil {
		t.Fatal(err)
	}
	if len(subscriptions["rejected"].([]any)) != 1 {
		t.Fatal(subscriptions)
	}
	w := apiRequest(a, "POST", "/api/chat", tokens.Access, map[string]any{"message": "hello", "user_uuid": owner.UUID}, nil)
	if w.Code != 201 || responseData(t, w)["user_uuid"] != uuid {
		t.Fatal(w.Code, w.Body.String())
	}
	var delivery map[string]any
	if err := wsjson.Read(ctx, c, &delivery); err != nil {
		t.Fatal(err)
	}
	if delivery["type"] != "event" {
		t.Fatal(delivery)
	}
	channel := "jellyfin.1.sessions"
	a.hub.publish(channel, "SessionUpdate", map[string]any{"active_count": 2, "summary": map[string]any{"private_total": 99}, "sessions": []any{map[string]any{"user": map[string]any{"uuid": uuid}}, map[string]any{"user": map[string]any{"uuid": owner.UUID}}}})
	if err := wsjson.Read(ctx, c, &delivery); err != nil {
		t.Fatal(err)
	}
	event := delivery["event"].(map[string]any)
	payload := event["payload"].(map[string]any)
	if payload["active_count"] != float64(1) || len(payload["sessions"].([]any)) != 1 || payload["summary"] != nil {
		t.Fatal("cross-user session data leaked", payload)
	}
	if _, err := s.writer.Exec("UPDATE user_accounts SET is_active=0 WHERE uuid=?", uuid); err != nil {
		t.Fatal(err)
	}
	a.hub.publish("chat.global", "ChatMessage", map[string]any{"message": "must not deliver"})
	if err := wsjson.Read(ctx, c, &delivery); err == nil {
		t.Fatal("inactive user received event")
	}
	if w := apiRequest(a, "GET", "/api/chat", tokens.Access, nil, nil); w.Code != 401 {
		t.Fatal(w.Code)
	}
}

func TestCrossOriginSocketAndShutdown(t *testing.T) {
	a, _ := testApp(t)
	token, _ := bootstrapOwner(t, a)
	server := httptest.NewServer(a)
	defer server.Close()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	_, response, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/ws", &websocket.DialOptions{HTTPHeader: http.Header{"Origin": []string{"http://evil.invalid"}}})
	if err == nil || response.StatusCode != 403 {
		t.Fatal("cross origin accepted", err)
	}
	if response != nil && response.Body != nil {
		io.Copy(io.Discard, response.Body)
		response.Body.Close()
	}
	c, _ := dialClient(t, server.URL, token)
	a.CloseRealtime()
	var message any
	if err := wsjson.Read(ctx, c, &message); err == nil {
		t.Fatal("socket survived shutdown")
	}
}

func TestFirstRunPagesRedirectToSetupUntilComplete(t *testing.T) {
	a, s := testApp(t)
	// Fresh install: every page except the setup wizard and its assets goes to setup.
	for path, want := range map[string]int{"/": 302, "/admin/users": 302, "/admin/login": 302, "/login": 302, "/invite/abc": 302, "/setup": 200, "/setup/account": 200, "/assets/main.js": 200, "/assets/missing.js": 404, "/api/missing": 404} {
		w := apiRequest(a, "GET", path, "", nil, nil)
		if w.Code != want || want == 302 && w.Header().Get("Location") != "/setup" {
			t.Fatal(path, w.Code, w.Header().Get("Location"))
		}
	}
	if w := apiRequest(a, "HEAD", "/admin/dashboard", "", nil, nil); w.Code != 302 {
		t.Fatal("HEAD not redirected", w.Code)
	}
	bootstrapOwner(t, a)
	if w := apiRequest(a, "GET", "/admin/dashboard", "", nil, nil); w.Code != 302 {
		t.Fatal("owner without completed setup skipped the wizard", w.Code)
	}
	activityExec(t, s, "INSERT INTO settings(key,value,value_type) VALUES('SETUP_COMPLETE','true','string')")
	for _, path := range []string{"/", "/admin/users", "/login", "/setup/account"} {
		if w := apiRequest(a, "GET", path, "", nil, nil); w.Code != 200 {
			t.Fatal("completed setup still redirected", path, w.Code)
		}
	}
}
