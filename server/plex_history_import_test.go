package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakePlexHistory serves /status/sessions/history/all from entries, a page at
// a time by the container headers, and records every request.
type fakePlexHistory struct {
	mu      sync.Mutex
	entries []string // one XML element each
	methods []string
	failAt  int // start offset that answers 503; -1 never
	block   chan struct{}
}

func (f *fakePlexHistory) client(t *testing.T) *http.Client {
	return &http.Client{Transport: providerTransport(func(r *http.Request) (*http.Response, error) {
		f.mu.Lock()
		f.methods = append(f.methods, r.Method+" "+r.URL.Path)
		entries, failAt, block := append([]string{}, f.entries...), f.failAt, f.block
		f.mu.Unlock()
		if block != nil {
			select {
			case <-block:
			case <-r.Context().Done():
				return nil, r.Context().Err()
			}
		}
		if r.Header.Get("X-Plex-Token") != "fixture-secret" || r.URL.Path != "/status/sessions/history/all" {
			t.Error("unexpected request", r.Method, r.URL)
			return &http.Response{StatusCode: 404, Header: http.Header{}, Body: io.NopCloser(strings.NewReader("")), Request: r}, nil
		}
		start, _ := strconv.Atoi(r.Header.Get("X-Plex-Container-Start"))
		size, _ := strconv.Atoi(r.Header.Get("X-Plex-Container-Size"))
		if start == failAt {
			return &http.Response{StatusCode: 503, Header: http.Header{}, Body: io.NopCloser(strings.NewReader("busy")), Request: r}, nil
		}
		end := min(start+size, len(entries))
		page := entries[min(start, len(entries)):end]
		body := fmt.Sprintf(`<MediaContainer size="%d" totalSize="%d" offset="%d">%s</MediaContainer>`, len(page), len(entries), start, strings.Join(page, ""))
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
	})}
}

func (f *fakePlexHistory) requests() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string{}, f.methods...)
}

func plexHistoryEntry(key, account, item string, viewed time.Time) string {
	rating := ""
	if item != "" {
		rating = ` ratingKey="` + item + `"`
	}
	return fmt.Sprintf(`<Video historyKey="/status/sessions/history/%s" accountID="%s"%s type="movie" title="Film %s" viewedAt="%d"/>`, key, account, rating, key, viewed.Unix())
}

type plexHistoryStatus struct {
	State           string  `json:"state"`
	Total           int     `json:"total"`
	Read            int     `json:"read"`
	Added           int     `json:"added"`
	AlreadyStored   int     `json:"already_stored"`
	AlreadyRecorded int     `json:"already_recorded"`
	UnknownAccounts int     `json:"unknown_accounts"`
	ErrorCode       *string `json:"error_code"`
	StoredPlays     int     `json:"stored_plays"`
	MUMSince        *string `json:"mum_since"`
}

func readPlexHistoryStatus(t *testing.T, a *App, token string, server int64) plexHistoryStatus {
	t.Helper()
	w := apiRequest(a, "GET", fmt.Sprintf("/api/servers/%d/plex-history", server), token, nil, nil)
	if w.Code != 200 {
		t.Fatal("status", w.Code, w.Body.String())
	}
	var out struct{ Data plexHistoryStatus }
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out.Data
}

func waitPlexHistory(t *testing.T, a *App, token string, server int64) plexHistoryStatus {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		status := readPlexHistoryStatus(t, a, token, server)
		if status.State != "running" {
			return status
		}
		if time.Now().After(deadline) {
			t.Fatal("import did not finish", status)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func plexHistoryFixture(t *testing.T, fake *fakePlexHistory) (*App, *Store, string, int64) {
	t.Helper()
	plexHistoryPageSize = 2
	t.Cleanup(func() { plexHistoryPageSize = 500 })
	a, s := testApp(t)
	a.ProviderHTTP = fake.client(t)
	token, _ := bootstrapOwner(t, a)
	activityExec(t, s, "UPDATE provider_settings SET enabled=1 WHERE provider_id='plex'")
	activityExec(t, s, `INSERT INTO media_servers(server_nickname,service_type,url,api_key) VALUES('Plex++','plex','http://plex.test','fixture-secret')`)
	var server int64
	if err := s.reader.QueryRow("SELECT id FROM media_servers WHERE server_nickname='Plex++'").Scan(&server); err != nil {
		t.Fatal(err)
	}
	return a, s, token, server
}

func startPlexHistory(a *App, token string, server int64) int {
	return apiRequest(a, "POST", fmt.Sprintf("/api/servers/%d/plex-history/import", server), token, nil, nil).Code
}

func TestPlexHistoryImportStoresOnlyWhatMUMLacks(t *testing.T) {
	seen := time.Date(2026, 11, 10, 20, 0, 0, 0, time.UTC)
	fake := &fakePlexHistory{failAt: -1, entries: []string{
		plexHistoryEntry("1", "42", "99", seen.AddDate(0, -3, 0)),     // an old play MUM never saw
		plexHistoryEntry("2", "42", "1234", seen.Add(50*time.Minute)), // the play MUM recorded below
		plexHistoryEntry("3", "77", "55", seen.AddDate(0, -1, 0)),     // an account MUM does not know yet
		plexHistoryEntry("4", "42", "", seen.AddDate(0, -2, 0)),       // a play of a deleted item
		plexHistoryEntry("5", "42", "1234", seen.Add(-48*time.Hour)),  // same item, an earlier viewing
	}}
	a, s, token, server := plexHistoryFixture(t, fake)
	viewer := seedExternalService(t, s, server, "42")
	activityExec(t, s, `INSERT INTO media_activity_history(server_id,external_session_id,service_uuid,item_id,media_type,title,first_seen_at,last_seen_at,paused) VALUES(?,?,?,?,?,?,?,?,0)`,
		server, "s1", viewer, "1234", "movie", "Film", utcTimestamp(seen), utcTimestamp(seen.Add(40*time.Minute)))

	if status := readPlexHistoryStatus(t, a, token, server); status.State != "never" {
		t.Fatal("before any import", status)
	}
	if code := startPlexHistory(a, token, server); code != 202 {
		t.Fatal("start", code)
	}
	status := waitPlexHistory(t, a, token, server)
	if status.State != "completed" || status.Total != 5 || status.Read != 5 || status.Added != 4 || status.AlreadyRecorded != 1 || status.AlreadyStored != 0 || status.UnknownAccounts != 1 || status.StoredPlays != 4 {
		t.Fatalf("first import %+v", status)
	}
	if status.MUMSince == nil || *status.MUMSince != utcTimestamp(seen) {
		t.Fatal("MUM's first recorded play", status.MUMSince)
	}
	var keys []string
	rows, err := s.reader.Query("SELECT history_key FROM plex_history_imports WHERE server_id=? ORDER BY history_key", server)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var key string
		_ = rows.Scan(&key)
		keys = append(keys, key)
	}
	rows.Close()
	if strings.Join(keys, ",") != "/status/sessions/history/1,/status/sessions/history/3,/status/sessions/history/4,/status/sessions/history/5" {
		t.Fatal("stored", keys)
	}

	// A later run adds only what Plex recorded since.
	fake.mu.Lock()
	fake.entries = append(fake.entries, plexHistoryEntry("6", "42", "7", seen.Add(72*time.Hour)))
	fake.mu.Unlock()
	if code := startPlexHistory(a, token, server); code != 202 {
		t.Fatal("second start", code)
	}
	status = waitPlexHistory(t, a, token, server)
	if status.State != "completed" || status.Added != 1 || status.AlreadyStored != 4 || status.AlreadyRecorded != 1 || status.StoredPlays != 5 {
		t.Fatalf("second import %+v", status)
	}
	for _, request := range fake.requests() {
		if !strings.HasPrefix(request, "GET ") {
			t.Fatal("the import wrote to Plex", request)
		}
	}
}

func TestPlexHistoryImportFailureKeepsEarlierPages(t *testing.T) {
	now := time.Now()
	fake := &fakePlexHistory{failAt: 2, entries: []string{
		plexHistoryEntry("1", "42", "1", now.AddDate(0, -1, 0)),
		plexHistoryEntry("2", "42", "2", now.AddDate(0, -1, 1)),
		plexHistoryEntry("3", "42", "3", now.AddDate(0, -1, 2)),
	}}
	a, _, token, server := plexHistoryFixture(t, fake)
	if code := startPlexHistory(a, token, server); code != 202 {
		t.Fatal("start", code)
	}
	status := waitPlexHistory(t, a, token, server)
	if status.State != "failed" || status.ErrorCode == nil || *status.ErrorCode != "plex_read_failed" || status.Added != 2 || status.StoredPlays != 2 {
		t.Fatalf("failed import %+v", status)
	}
}

func TestPlexHistoryImportAuthorityAndOneRunAtATime(t *testing.T) {
	fake := &fakePlexHistory{failAt: -1, block: make(chan struct{}), entries: []string{plexHistoryEntry("1", "42", "1", time.Now())}}
	a, s, token, server := plexHistoryFixture(t, fake)
	owner, err := s.Authenticate(t.Context(), token)
	if err != nil {
		t.Fatal(err)
	}
	hash, err := hashPassword("a-strong-member-password")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateAccount(t.Context(), owner.UUID, "viewer", hash, false); err != nil {
		t.Fatal(err)
	}
	w := apiRequest(a, "POST", "/api/auth/login", "", map[string]any{"username": "viewer", "password": "a-strong-member-password"}, nil)
	viewer := responseData(t, w)["access_token"].(string)
	if code := startPlexHistory(a, viewer, server); code != 403 {
		t.Fatal("a viewer started an import", code)
	}
	if w := apiRequest(a, "GET", fmt.Sprintf("/api/servers/%d/plex-history", server), viewer, nil, nil); w.Code != 403 {
		t.Fatal("a viewer read the import status", w.Code)
	}
	activityExec(t, s, `INSERT INTO media_servers(server_nickname,service_type,url,api_key) VALUES('Jelly','jellyfin','http://jelly.test','fixture-secret')`)
	var jelly int64
	_ = s.reader.QueryRow("SELECT id FROM media_servers WHERE server_nickname='Jelly'").Scan(&jelly)
	if code := startPlexHistory(a, token, jelly); code != 409 {
		t.Fatal("imported from a Jellyfin server", code)
	}
	if code := startPlexHistory(a, token, 9999); code != 404 {
		t.Fatal("unknown server", code)
	}
	if code := startPlexHistory(a, token, server); code != 202 {
		t.Fatal("start", code)
	}
	if code := startPlexHistory(a, token, server); code != 409 {
		t.Fatal("a second run started while one is going", code)
	}
	close(fake.block)
	if status := waitPlexHistory(t, a, token, server); status.State != "completed" || status.Added != 1 {
		t.Fatalf("after unblocking %+v", status)
	}
	if len(fake.requests()) == 0 {
		t.Fatal("no requests")
	}
}

func TestPlexHistoryImportStoppedByShutdownIsMarkedOnRestart(t *testing.T) {
	fake := &fakePlexHistory{failAt: -1, entries: []string{}}
	_, s, _, server := plexHistoryFixture(t, fake)
	activityExec(t, s, "INSERT INTO plex_history_import_runs(server_id,state,started_at) VALUES(?,'running',?)", server, utcTimestamp(time.Now()))
	if err := recoverPlexHistoryImports(t.Context(), s); err != nil {
		t.Fatal(err)
	}
	var state string
	var finished, code *string
	if err := s.reader.QueryRow("SELECT state,finished_at,error_code FROM plex_history_import_runs WHERE server_id=?", server).Scan(&state, &finished, &code); err != nil {
		t.Fatal(err)
	}
	if state != "stopped" || finished == nil || code == nil || *code != "interrupted" {
		t.Fatal("recovered run", state, finished, code)
	}
}
