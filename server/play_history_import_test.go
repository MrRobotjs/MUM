package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"app/server/providers/provider"
)

// fakePlexHistory serves /status/sessions/history/all from entries, a page at
// a time by the container headers, and records every request.
type fakePlexHistory struct {
	mu      sync.Mutex
	entries []string // one XML element each
	methods []string
	queries []string // the raw query of every request
	failAt  int // start offset that answers 503; -1 never
	block   chan struct{}
	onPage  func(f *fakePlexHistory, start int) // called after a page is served, with f.mu held
}

func (f *fakePlexHistory) client(t *testing.T) *http.Client {
	return &http.Client{Transport: providerTransport(func(r *http.Request) (*http.Response, error) {
		f.mu.Lock()
		f.methods = append(f.methods, r.Method+" "+r.URL.Path)
		f.queries = append(f.queries, r.URL.RawQuery)
		entries, failAt, block := append([]string{}, f.entries...), f.failAt, f.block
		// Plex answers one account's history when asked.
		if account := r.URL.Query().Get("accountID"); account != "" {
			entries = slices.DeleteFunc(entries, func(e string) bool { return !strings.Contains(e, `accountID="`+account+`"`) })
		}
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
		f.mu.Lock()
		if f.onPage != nil {
			f.onPage(f, start)
		}
		f.mu.Unlock()
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
	w := apiRequest(a, "GET", fmt.Sprintf("/api/servers/%d/play-history", server), token, nil, nil)
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
	historyPageSize = 2
	t.Cleanup(func() { historyPageSize = 500 })
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
	return apiRequest(a, "POST", fmt.Sprintf("/api/servers/%d/play-history/import", server), token, nil, nil).Code
}

func TestPlayHistoryImportStoresOnlyWhatMUMLacks(t *testing.T) {
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
	rows, err := s.reader.Query("SELECT entry_key FROM history_imports WHERE server_id=? ORDER BY entry_key", server)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var key string
		_ = rows.Scan(&key)
		keys = append(keys, key)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
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

func TestPlayHistoryImportFailureKeepsEarlierPages(t *testing.T) {
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
	if status.State != "failed" || status.ErrorCode == nil || *status.ErrorCode != "server_read_failed" || status.Added != 2 || status.StoredPlays != 2 {
		t.Fatalf("failed import %+v", status)
	}
}

func TestPlayHistoryImportAuthorityAndOneRunAtATime(t *testing.T) {
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
	if w := apiRequest(a, "GET", fmt.Sprintf("/api/servers/%d/play-history", server), viewer, nil, nil); w.Code != 403 {
		t.Fatal("a viewer read the import status", w.Code)
	}
	activityExec(t, s, `INSERT INTO media_servers(server_nickname,service_type,url,api_key) VALUES('Books','kavita','http://kavita.test','fixture-secret')`)
	var books int64
	_ = s.reader.QueryRow("SELECT id FROM media_servers WHERE server_nickname='Books'").Scan(&books)
	if code := startPlexHistory(a, token, books); code != 409 {
		t.Fatal("imported from a Kavita server", code)
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

func TestPlayHistoryImportStoppedByShutdownIsMarkedOnRestart(t *testing.T) {
	fake := &fakePlexHistory{failAt: -1, entries: []string{}}
	_, s, _, server := plexHistoryFixture(t, fake)
	activityExec(t, s, "INSERT INTO history_import_runs(server_id,state,started_at) VALUES(?,'running',?)", server, utcTimestamp(time.Now()))
	if err := recoverHistoryImports(t.Context(), s); err != nil {
		t.Fatal(err)
	}
	var state string
	var finished, code *string
	if err := s.reader.QueryRow("SELECT state,finished_at,error_code FROM history_import_runs WHERE server_id=?", server).Scan(&state, &finished, &code); err != nil {
		t.Fatal(err)
	}
	if state != "stopped" || finished == nil || code == nil || *code != "interrupted" {
		t.Fatal("recovered run", state, finished, code)
	}
}

// Every run fills in a poster a stored play lacks and never replaces one.
func TestPlayHistoryImportFillsMissingPostersOnly(t *testing.T) {
	viewed := time.Date(2026, 10, 1, 20, 0, 0, 0, time.UTC).Unix()
	entry := func(key, item, thumb string) string {
		return fmt.Sprintf(`<Video historyKey="/status/sessions/history/%s" accountID="42" ratingKey="%s" thumb="%s" type="movie" title="Film" viewedAt="%d"/>`, key, item, thumb, viewed)
	}
	fake := &fakePlexHistory{failAt: -1, entries: []string{
		entry("1", "10", ""),                             // no poster yet
		entry("2", "20", "/library/metadata/20/thumb/1"), // stored with its poster
		entry("3", "30", "/library/metadata/99/thumb/1"), // another item's path: never stored
	}}
	a, s, token, server := plexHistoryFixture(t, fake)
	posters := func() string {
		t.Helper()
		rows, err := s.reader.Query("SELECT entry_key,coalesce(poster_item,''),coalesce(poster_path,'') FROM history_imports WHERE server_id=? ORDER BY entry_key", server)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		var out []string
		for rows.Next() {
			var key, item, path string
			_ = rows.Scan(&key, &item, &path)
			out = append(out, strings.TrimPrefix(key, "/status/sessions/history/")+"="+item+path)
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		return strings.Join(out, ",")
	}
	if code := startPlexHistory(a, token, server); code != 202 {
		t.Fatal("start", code)
	}
	if status := waitPlexHistory(t, a, token, server); status.State != "completed" || status.Added != 3 {
		t.Fatalf("first import %+v", status)
	}
	if got := posters(); got != "1=,2=20/library/metadata/20/thumb/1,3=" {
		t.Fatal("first import posters", got)
	}
	// Plex now has a poster for the first play and a newer one for the second.
	fake.mu.Lock()
	fake.entries = []string{entry("1", "10", "/library/metadata/10/thumb/5"), entry("2", "20", "/library/metadata/20/thumb/9"), entry("3", "30", "/library/metadata/99/thumb/1")}
	fake.mu.Unlock()
	if code := startPlexHistory(a, token, server); code != 202 {
		t.Fatal("second start", code)
	}
	if status := waitPlexHistory(t, a, token, server); status.State != "completed" || status.Added != 0 || status.AlreadyStored != 3 {
		t.Fatalf("second import %+v", status)
	}
	if got := posters(); got != "1=10/library/metadata/10/thumb/5,2=20/library/metadata/20/thumb/1,3=" {
		t.Fatal("second import posters", got)
	}
}

// A play the server adds in front while a run pages through the history moves
// the later pages back: the run sees one entry twice and stores it once, and
// the next run picks up the new play. Nothing is skipped or stored twice.
func TestPlayHistoryReimportWithShiftedOffsets(t *testing.T) {
	now := time.Now().UTC()
	fake := &fakePlexHistory{failAt: -1, entries: []string{
		plexHistoryEntry("1", "42", "1", now.AddDate(0, -1, 0)),
		plexHistoryEntry("2", "42", "2", now.AddDate(0, -1, 1)),
		plexHistoryEntry("3", "42", "3", now.AddDate(0, -1, 2)),
	}}
	fake.onPage = func(f *fakePlexHistory, start int) {
		if start == 0 {
			f.entries = append([]string{plexHistoryEntry("0", "42", "9", now.AddDate(0, 0, -1))}, f.entries...)
			f.onPage = nil
		}
	}
	a, s, token, server := plexHistoryFixture(t, fake)
	if code := startPlexHistory(a, token, server); code != 202 {
		t.Fatal("start", code)
	}
	if status := waitPlexHistory(t, a, token, server); status.State != "completed" || status.Added != 3 || status.AlreadyStored != 1 {
		t.Fatalf("first run %+v", status)
	}
	if code := startPlexHistory(a, token, server); code != 202 {
		t.Fatal("second start", code)
	}
	if status := waitPlexHistory(t, a, token, server); status.State != "completed" || status.Added != 1 || status.StoredPlays != 4 {
		t.Fatalf("second run %+v", status)
	}
	var rows int
	_ = s.reader.QueryRow("SELECT count(*) FROM history_imports WHERE server_id=?", server).Scan(&rows)
	if rows != 4 {
		t.Fatal("stored", rows)
	}
}

// A Jellyfin user ID written with dashes and capitals in the activity log is
// stored under the account's own form, so the play counts for that account.
func TestPlayHistoryJellyfinMatchesDashedUserID(t *testing.T) {
	historyPageSize = 50
	t.Cleanup(func() { historyPageSize = 500 })
	a, s := testApp(t)
	var requests []string
	a.ProviderHTTP = &http.Client{Transport: providerTransport(func(r *http.Request) (*http.Response, error) {
		requests = append(requests, r.Method+" "+r.URL.Path)
		body := `{"Items":[]}`
		switch r.URL.Path {
		case "/System/ActivityLog/Entries":
			body = `{"Items":[{"Id":7,"Type":"VideoPlaybackStopped","ItemId":"m1","UserId":"AB12CD34-AB12-CD34-AB12-CD34AB12CD34","Date":"2026-11-10T21:00:00.0000000Z"},
			 {"Id":8,"Type":"VideoPlaybackStopped","ItemId":"m2","UserId":"FFFF0000-AB12-CD34-AB12-CD34AB12CD34","Date":"2026-11-10T22:00:00.0000000Z"}],"TotalRecordCount":2}`
		case "/Items":
			body = `{"Items":[{"Id":"m1","Name":"Film","Type":"Movie","ImageTags":{"Primary":"tag1"}}]}`
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
	})}
	token, _ := bootstrapOwner(t, a)
	activityExec(t, s, "UPDATE provider_settings SET enabled=1 WHERE provider_id='jellyfin'")
	activityExec(t, s, `INSERT INTO media_servers(server_nickname,service_type,url,api_key) VALUES('Jelly','jellyfin','http://jelly.test','fixture-secret')`)
	var server int64
	if err := s.reader.QueryRow("SELECT id FROM media_servers WHERE server_nickname='Jelly'").Scan(&server); err != nil {
		t.Fatal(err)
	}
	seedExternalService(t, s, server, "ab12cd34ab12cd34ab12cd34ab12cd34")
	if code := startPlexHistory(a, token, server); code != 202 {
		t.Fatal("start", code)
	}
	status := waitPlexHistory(t, a, token, server)
	if status.State != "completed" || status.Added != 2 || status.UnknownAccounts != 1 {
		t.Fatalf("import %+v", status)
	}
	got := map[string]string{}
	rows, err := s.reader.Query("SELECT entry_key,account_id||' '||coalesce(title,'')||' '||coalesce(poster_path,'') FROM history_imports WHERE server_id=?", server)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var key, value string
		_ = rows.Scan(&key, &value)
		got[key] = value
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	rows.Close()
	if got["a7"] != "ab12cd34ab12cd34ab12cd34ab12cd34 Film tag1" || got["a8"] != "ffff0000ab12cd34ab12cd34ab12cd34  " {
		t.Fatal("stored", got)
	}
	for _, request := range requests {
		if !strings.HasPrefix(request, "GET ") {
			t.Fatal("the import wrote to Jellyfin", request)
		}
	}
}

// An activity log page that holds no plays does not end the import: the run
// advances by the records read and finds the plays on later pages.
func TestPlayHistoryContinuesPastPagesWithoutPlays(t *testing.T) {
	historyPageSize = 2
	t.Cleanup(func() { historyPageSize = 500 })
	a, s := testApp(t)
	a.ProviderHTTP = &http.Client{Transport: providerTransport(func(r *http.Request) (*http.Response, error) {
		body := `{"Items":[]}`
		if r.URL.Path == "/emby/System/ActivityLog/Entries" {
			switch r.URL.Query().Get("StartIndex") {
			case "0":
				body = `{"Items":[{"Id":1,"Type":"user.authenticated","UserId":"u1","Date":"2026-11-10T21:00:00Z"},{"Id":2,"Type":"playback.start","ItemId":"m1","UserId":"u1","Date":"2026-11-10T21:00:00Z"}],"TotalRecordCount":3}`
			case "2":
				body = `{"Items":[{"Id":3,"Type":"playback.stop","ItemId":"m1","UserId":"u1","Date":"2026-11-10T22:00:00Z"}],"TotalRecordCount":3}`
			}
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
	})}
	token, _ := bootstrapOwner(t, a)
	activityExec(t, s, "UPDATE provider_settings SET enabled=1 WHERE provider_id='emby'")
	activityExec(t, s, `INSERT INTO media_servers(server_nickname,service_type,url,api_key) VALUES('Emby','emby','http://emby.test','fixture-secret')`)
	var server int64
	_ = s.reader.QueryRow("SELECT id FROM media_servers WHERE server_nickname='Emby'").Scan(&server)
	if code := startPlexHistory(a, token, server); code != 202 {
		t.Fatal("start", code)
	}
	if status := waitPlexHistory(t, a, token, server); status.State != "completed" || status.Read != 3 || status.Added != 1 {
		t.Fatalf("import %+v", status)
	}
}

// Audiobookshelf's listening time is stored with the play, and a stored play
// gains it on a later import when it has none; a stored value never changes.
func TestPlayHistoryStoresListeningTime(t *testing.T) {
	a, s := testApp(t)
	activityExec(t, s, `INSERT INTO media_servers(server_nickname,service_type,url,api_key) VALUES('Books','audiobookshelf','http://abs.test','fixture-secret')`)
	var server int64
	_ = s.reader.QueryRow("SELECT id FROM media_servers WHERE server_nickname='Books'").Scan(&server)
	seconds := func(v int64) *int64 { return &v }
	viewed := time.Date(2026, 11, 1, 5, 0, 0, 0, time.UTC)
	store := func(key string, listened *int64) {
		t.Helper()
		page := provider.HistoryPage{Entries: []provider.HistoryEntry{{Key: key, AccountID: "u", ViewedAt: viewed, Type: "book", ListenedSeconds: listened}}, Read: 1, Total: 1}
		if err := a.storeHistoryPage(t.Context(), server, "audiobookshelf", page); err != nil {
			t.Fatal(err)
		}
	}
	listened := func(key string) (v sql.NullInt64) {
		_ = s.reader.QueryRow("SELECT listened_seconds FROM history_imports WHERE entry_key=?", key).Scan(&v)
		return v
	}
	store("a", seconds(120))
	store("b", nil)
	if listened("a").Int64 != 120 || listened("b").Valid {
		t.Fatal("first import", listened("a"), listened("b"))
	}
	store("a", seconds(999))
	store("b", seconds(60))
	if listened("a").Int64 != 120 || listened("b").Int64 != 60 {
		t.Fatal("re-import", listened("a"), listened("b"))
	}
}
