package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// terminateUpstream is a fake Jellyfin server that records the stream
// commands it receives and answers status for every request.
type terminateUpstream struct {
	server *httptest.Server
	mu     sync.Mutex
	calls  []string
	text   string
	status int
}

func newTerminateUpstream(t *testing.T) *terminateUpstream {
	t.Helper()
	up := &terminateUpstream{status: http.StatusNoContent}
	up.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		up.mu.Lock()
		defer up.mu.Unlock()
		if r.Header.Get("X-Emby-Token") != "fixture-secret" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		up.calls = append(up.calls, r.Method+" "+r.URL.Path)
		if strings.HasSuffix(r.URL.Path, "/Message") {
			var body struct{ Header, Text string }
			_ = json.NewDecoder(r.Body).Decode(&body)
			up.text = body.Header + ": " + body.Text
		}
		w.WriteHeader(up.status)
	}))
	t.Cleanup(up.server.Close)
	return up
}

func (up *terminateUpstream) seen() []string {
	up.mu.Lock()
	defer up.mu.Unlock()
	return append([]string{}, up.calls...)
}

// terminateFixture is an owner, a Jellyfin server at up and one current stream
// on it with session "live-1"; it returns the owner token and the stream's id.
func terminateFixture(t *testing.T, up *terminateUpstream) (*App, *Store, string, string) {
	t.Helper()
	a, s := testApp(t)
	a.ProviderHTTP = up.server.Client()
	token, _ := bootstrapOwner(t, a)
	activityExec(t, s, "UPDATE provider_settings SET enabled=1 WHERE provider_id='jellyfin'")
	activityExec(t, s, `INSERT INTO media_servers(server_nickname,service_type,url,api_key) VALUES('Jelly++','jellyfin',?,'fixture-secret')`, up.server.URL)
	var server int64
	if err := s.reader.QueryRow("SELECT id FROM media_servers WHERE server_nickname='Jelly++'").Scan(&server); err != nil {
		t.Fatal(err)
	}
	now := utcTimestamp(time.Now())
	viewer := seedExternalService(t, s, server, "viewer-1")
	activityExec(t, s, `INSERT INTO media_activity_history(server_id,external_session_id,service_uuid,item_id,media_type,title,first_seen_at,last_seen_at,paused) VALUES(?,?,?,?,?,?,?,?,0)`, server, "live-1", viewer, "item", "movie", "Live play", now, now)
	activityExec(t, s, `INSERT INTO media_activity_current(server_id,external_session_id,history_id) SELECT server_id,external_session_id,id FROM media_activity_history WHERE external_session_id='live-1'`)
	var history string
	if err := s.reader.QueryRow("SELECT CAST(history_id AS TEXT) FROM media_activity_current").Scan(&history); err != nil {
		t.Fatal(err)
	}
	return a, s, token, history
}

func terminate(a *App, token, history, message string) *httptest.ResponseRecorder {
	return apiRequest(a, "POST", "/api/activity/current/"+history+"/terminate", token, map[string]any{"message": message}, nil)
}

func terminateOutcomes(t *testing.T, s *Store) []string {
	t.Helper()
	rows, err := s.reader.Query("SELECT json_extract(details,'$.outcome') FROM audit_events WHERE action='stream.terminate' ORDER BY id")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var outcome string
		if err := rows.Scan(&outcome); err != nil {
			t.Fatal(err)
		}
		out = append(out, outcome)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

// The owner stops a Jellyfin stream: the viewer is shown the message, then
// playback stops; the attempt is audited once and never retried.
func TestTerminateStreamStopsJellyfinPlayback(t *testing.T) {
	up := newTerminateUpstream(t)
	a, s, token, history := terminateFixture(t, up)
	if w := terminate(a, token, history, "  Server maintenance  "); w.Code != 200 || responseData(t, w)["status"] != "terminated" {
		t.Fatal(w.Code, w.Body.String())
	}
	if calls := up.seen(); strings.Join(calls, ",") != "POST /Sessions/live-1/Message,POST /Sessions/live-1/Playing/Stop" {
		t.Fatal("upstream calls", calls)
	}
	if up.text != "MUM: Server maintenance" {
		t.Fatal("message", up.text)
	}
	if got := terminateOutcomes(t, s); len(got) != 1 || got[0] != "terminated" {
		t.Fatal("audit", got)
	}
	// Without a message only playback is stopped.
	up.calls = nil
	if w := terminate(a, token, history, ""); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if calls := up.seen(); strings.Join(calls, ",") != "POST /Sessions/live-1/Playing/Stop" {
		t.Fatal("upstream calls without message", calls)
	}
}

// Only the owner and full administrators may stop streams, and bad input or
// an unknown stream never reaches the server.
func TestTerminateStreamAuthorityAndInput(t *testing.T) {
	up := newTerminateUpstream(t)
	a, s, token, history := terminateFixture(t, up)
	owner, err := s.Authenticate(t.Context(), token)
	if err != nil {
		t.Fatal(err)
	}
	hash, err := hashPassword("a-strong-member-password")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"viewer", "role-admin", "full-admin"} {
		if _, err := s.CreateAccount(t.Context(), owner.UUID, name, hash, false); err != nil {
			t.Fatal(err)
		}
	}
	// A role without the administrator permission does not count.
	activityExec(t, s, "INSERT INTO admin_roles(id,name,position) VALUES('cosmetic','Cosmetic',5),('full','Full',6)")
	activityExec(t, s, "INSERT INTO admin_role_permissions VALUES('full','admin')")
	activityExec(t, s, "INSERT INTO admin_privileges SELECT uuid,'cosmetic' FROM user_accounts WHERE local_username='role-admin'")
	activityExec(t, s, "INSERT INTO admin_privileges SELECT uuid,'full' FROM user_accounts WHERE local_username='full-admin'")
	signIn := func(name string) string {
		t.Helper()
		w := apiRequest(a, "POST", "/api/auth/login", "", map[string]any{"username": name, "password": "a-strong-member-password"}, nil)
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
		return responseData(t, w)["access_token"].(string)
	}
	for _, name := range []string{"viewer", "role-admin"} {
		if w := terminate(a, signIn(name), history, ""); w.Code != 403 {
			t.Fatal(name, "stopped a stream", w.Code, w.Body.String())
		}
	}
	if w := terminate(a, token, history, strings.Repeat("x", 501)); w.Code != 400 {
		t.Fatal("long message", w.Code)
	}
	if w := terminate(a, token, history, "bad\x00message"); w.Code != 400 {
		t.Fatal("control character", w.Code)
	}
	if w := terminate(a, token, "999999", ""); w.Code != 404 {
		t.Fatal("unknown stream", w.Code)
	}
	if calls := up.seen(); len(calls) != 0 {
		t.Fatal("refused requests reached the server", calls)
	}
	if w := terminate(a, signIn("full-admin"), history, ""); w.Code != 200 {
		t.Fatal("full administrator", w.Code, w.Body.String())
	}
}

// What the server answers decides the outcome; each is audited, none retried.
func TestTerminateStreamOutcomes(t *testing.T) {
	up := newTerminateUpstream(t)
	a, s, token, history := terminateFixture(t, up)
	for _, c := range []struct {
		status int
		code   string
		want   int
	}{{http.StatusNotFound, "STREAM_ENDED", 409}, {http.StatusForbidden, "TERMINATE_REFUSED", 409}, {http.StatusInternalServerError, "TERMINATE_FAILED", 502}} {
		up.mu.Lock()
		up.status, up.calls = c.status, nil
		up.mu.Unlock()
		w := terminate(a, token, history, "")
		if w.Code != c.want || errorCode(t, w.Body.String()) != c.code {
			t.Fatal(c.status, w.Code, w.Body.String())
		}
		if calls := up.seen(); len(calls) != 1 {
			t.Fatal("retried", calls)
		}
	}
	if got := strings.Join(terminateOutcomes(t, s), ","); got != "already_ended,refused,failed" {
		t.Fatal("audit", got)
	}
	if strings.Contains(strings.Join(terminateOutcomes(t, s), ","), "fixture-secret") {
		t.Fatal("secret in audit")
	}
}
