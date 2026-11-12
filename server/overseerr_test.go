package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

type overseerrFixture struct {
	server    *httptest.Server
	mu        sync.Mutex
	key       string
	mode      string
	users     []map[string]any
	requests  int
	onUsers   func()
	status    int
	posts     int
	requester int
}

func newOverseerrFixture(t *testing.T) *overseerrFixture {
	t.Helper()
	f := &overseerrFixture{key: "overseerr-secret", status: 1, requester: 5}
	f.users = []map[string]any{
		{"id": 5, "plexId": 1001, "displayName": "Linked Viewer", "email": "viewer@example.invalid"},
		// Same visible name as an unlinked Plex account, but no Plex ID: never linked.
		{"id": 6, "username": "plex-1002", "displayName": "plex-1002"},
		{"id": 7, "plexId": 9999, "displayName": "Other Plex"},
	}
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		mode, key, hook := f.mode, f.key, f.onUsers
		f.mu.Unlock()
		if r.URL.Path == "/api/v1/status" {
			_, _ = w.Write([]byte(`{"version":"1.33.2"}`))
			return
		}
		if r.Header.Get("X-Api-Key") != key {
			http.Error(w, `{"message":"secret upstream detail"}`, 401)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/v1/user":
			if hook != nil && r.URL.Query().Get("skip") == "0" && r.URL.Query().Get("take") == "100" {
				hook()
			}
			skip, _ := strconv.Atoi(r.URL.Query().Get("skip"))
			take, _ := strconv.Atoi(r.URL.Query().Get("take"))
			f.mu.Lock()
			users := f.users
			f.mu.Unlock()
			// Two-user pages exercise pagination.
			if take > 2 {
				take = 2
			}
			end := min(skip+take, len(users))
			page := users[min(skip, len(users)):end]
			total := len(users)
			switch mode {
			case "short":
				if skip > 0 {
					page = nil
				}
			case "no_page_info":
				_ = json.NewEncoder(w).Encode(map[string]any{"results": page})
				return
			case "duplicate_plex":
				page = append(page, map[string]any{"id": 99, "plexId": 1001})
				total++
			}
			if page == nil {
				page = []map[string]any{}
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"pageInfo": map[string]any{"results": total, "pages": 2}, "results": page})
		case r.URL.Path == "/api/v1/request":
			f.mu.Lock()
			f.requests++
			f.mu.Unlock()
			if mode == "requests_down" {
				http.Error(w, "private upstream failure", 500)
				return
			}
			if r.URL.Query().Get("requestedBy") != "5" || r.URL.Query().Get("take") != "5" {
				t.Error("request page not scoped to the linked user", r.URL.RawQuery)
			}
			_, _ = w.Write([]byte(`{"pageInfo":{"results":7,"pages":2},"results":[{"id":41,"status":1,"type":"movie","createdAt":"2026-11-01T00:00:00.000Z","requestedBy":{"email":"viewer@example.invalid","plexToken":"private-plex-token"},"media":{"mediaType":"movie","tmdbId":603,"status":2,"plexUrl":"http://private"}}]}`))
		case r.Method == "GET" && r.URL.Path == "/api/v1/request/41":
			f.mu.Lock()
			status, requester := f.status, f.requester
			f.mu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]any{"id": 41, "status": status, "requestedBy": map[string]any{"id": requester}})
		case r.Method == "POST" && (r.URL.Path == "/api/v1/request/41/approve" || r.URL.Path == "/api/v1/request/41/decline"):
			f.mu.Lock()
			f.posts++
			if mode != "ignore_action" {
				f.status = map[bool]int{true: 2, false: 3}[strings.HasSuffix(r.URL.Path, "approve")]
			}
			f.mu.Unlock()
			if mode == "drop_action" {
				panic(http.ErrAbortHandler)
			}
			w.WriteHeader(200)
			_, _ = w.Write([]byte(`{}`))
		case r.URL.Path == "/api/v1/movie/603":
			_, _ = w.Write([]byte(`{"title":"The Fixture","releaseDate":"1999-03-31","posterPath":"/poster.jpg","backdropPath":"https://evil.invalid/x.jpg","overview":"A disposable film.","voteAverage":8.2,"credits":{"cast":[]}}`))
		default:
			t.Error("unexpected Overseerr request", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(f.server.Close)
	return f
}

func overseerrServer(t *testing.T, a *App, token string, f *overseerrFixture) int64 {
	t.Helper()
	id := createManagedServer(t, a, token, "plex", "http://plex.fixture.invalid")
	w := apiRequest(a, "PATCH", "/api/servers/"+strconv.FormatInt(id, 10), token, map[string]any{"overseerr_enabled": true, "overseerr_url": f.server.URL + "/", "overseerr_api_key": f.key}, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if strings.Contains(w.Body.String(), f.key) {
		t.Fatal("Overseerr key returned")
	}
	saved := responseData(t, w)
	if saved["overseerr_enabled"] != true || saved["overseerr_url"] != f.server.URL || saved["has_overseerr_api_key"] != true {
		t.Fatal(saved)
	}
	return id
}

func seedPlexAccount(t *testing.T, s *Store, server int64, plexID, name string) string {
	t.Helper()
	id := newUUID()
	now := utcTimestamp(time.Now())
	activityExec(t, s, "INSERT INTO identities(uuid,kind) VALUES(?,'service')", id)
	activityExec(t, s, "INSERT INTO service_accounts(uuid,server_id,external_user_id,external_username,created_at,updated_at) VALUES(?,?,?,?,?,?)", id, server, plexID, name, now, now)
	return id
}

func overseerrLinks(t *testing.T, s *Store, server int64) map[string]int64 {
	t.Helper()
	rows, err := s.reader.Query("SELECT a.external_user_id,l.overseerr_user_id FROM overseerr_links l JOIN service_accounts a ON a.uuid=l.service_uuid WHERE l.server_id=?", server)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	out := map[string]int64{}
	for rows.Next() {
		var plex string
		var user int64
		rows.Scan(&plex, &user)
		out[plex] = user
	}
	return out
}

func TestOverseerrConfigurationIsPlexOnlyVerifiedAndWriteOnly(t *testing.T) {
	f := newOverseerrFixture(t)
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	w := apiRequest(a, "GET", "/api/providers", token, nil, nil)
	var providers struct {
		Data []any `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &providers); err != nil || len(providers.Data) == 0 {
		t.Fatal(w.Body.String())
	}
	for _, entry := range providers.Data {
		p := entry.(map[string]any)
		has := strings.Contains(strings.Join(func() []string {
			out := []string{}
			for _, c := range p["capabilities"].([]any) {
				out = append(out, c.(string))
			}
			return out
		}(), ","), "integrations.overseerr")
		if has != (p["id"] == "plex") {
			t.Fatal("Overseerr capability advertised for", p["id"])
		}
	}
	jellyfin := createManagedServer(t, a, token, "jellyfin", "http://jellyfin.fixture.invalid")
	if w := apiRequest(a, "PATCH", "/api/servers/"+strconv.FormatInt(jellyfin, 10), token, map[string]any{"overseerr_enabled": true, "overseerr_url": f.server.URL, "overseerr_api_key": f.key}, nil); w.Code != 422 {
		t.Fatal("Overseerr attached to Jellyfin", w.Code)
	}
	probe := apiRequest(a, "POST", "/api/servers", token, map[string]any{"server_nickname": "Probe plex", "service_type": "plex", "url": "http://probe.fixture.invalid", "api_key": "fixture-secret"}, nil)
	if probe.Code != 201 {
		t.Fatal(probe.Code, probe.Body.String())
	}
	path := "/api/servers/" + strconv.FormatInt(int64(responseData(t, probe)["id"].(float64)), 10)
	for body, code := range map[string]int{`{"overseerr_enabled":true,"overseerr_url":"ftp://x","overseerr_api_key":"k"}`: 400, `{"overseerr_enabled":true,"overseerr_url":"` + f.server.URL + `","overseerr_api_key":"wrong"}`: 502} {
		var input map[string]any
		json.Unmarshal([]byte(body), &input)
		w := apiRequest(a, "PATCH", path, token, input, nil)
		if w.Code != code || strings.Contains(w.Body.String(), "secret upstream detail") {
			t.Fatal(body, w.Code, w.Body.String())
		}
	}
	if w := apiRequest(a, "GET", path, token, nil, nil); responseData(t, w)["overseerr_enabled"] != false {
		t.Fatal("rejected Overseerr configuration saved")
	}
	saved := overseerrServer(t, a, token, f)
	path = "/api/servers/" + strconv.FormatInt(saved, 10)
	// An unchanged configuration (key omitted) is kept and not re-tested.
	f.mu.Lock()
	f.key = "rotated-upstream"
	f.mu.Unlock()
	if w := apiRequest(a, "PATCH", path, token, map[string]any{"server_nickname": "Renamed Plex", "overseerr_enabled": true, "overseerr_url": f.server.URL}, nil); w.Code != 200 || responseData(t, w)["has_overseerr_api_key"] != true {
		t.Fatal("unchanged configuration re-tested or key dropped", w.Code, w.Body.String())
	}
	// A new key is tested before it is stored; a rejected key changes nothing.
	if w := apiRequest(a, "PATCH", path, token, map[string]any{"overseerr_enabled": true, "overseerr_url": f.server.URL, "overseerr_api_key": "still-wrong"}, nil); w.Code != 502 {
		t.Fatal("unverified key accepted", w.Code)
	}
	var key string
	s.reader.QueryRow("SELECT overseerr_api_key FROM media_servers WHERE id=?", saved).Scan(&key)
	if key != "overseerr-secret" {
		t.Fatal("rejected key stored")
	}
}

func TestOverseerrLinksMatchOnlyExactPlexAccountIDs(t *testing.T) {
	f := newOverseerrFixture(t)
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	server := overseerrServer(t, a, token, f)
	seedPlexAccount(t, s, server, "1001", "viewer")
	seedPlexAccount(t, s, server, "1002", "plex-1002")
	if err := a.refreshOverseerrLinks(t.Context(), server); err != nil {
		t.Fatal(err)
	}
	if links := overseerrLinks(t, s, server); len(links) != 1 || links["1001"] != 5 {
		t.Fatal("links", links)
	}
	// Failed or incomplete snapshots keep the previous links.
	for _, mode := range []string{"short", "no_page_info", "duplicate_plex"} {
		f.mu.Lock()
		f.mode = mode
		f.mu.Unlock()
		if err := a.refreshOverseerrLinks(t.Context(), server); err == nil {
			t.Fatal(mode, "incomplete snapshot accepted")
		}
		var result string
		s.reader.QueryRow("SELECT last_result FROM overseerr_state WHERE server_id=?", server).Scan(&result)
		if links := overseerrLinks(t, s, server); len(links) != 1 || result != "failed" {
			t.Fatal(mode, links, result)
		}
	}
	f.mu.Lock()
	f.mode = ""
	f.mu.Unlock()
	// A configuration change during the read wins over the read's results.
	f.onUsers = func() {
		activityExec(t, s, "UPDATE media_servers SET overseerr_url=? WHERE id=?", f.server.URL+"/changed", server)
	}
	if err := a.refreshOverseerrLinks(t.Context(), server); !errors.Is(err, ErrConflict) {
		t.Fatal("stale refresh committed", err)
	}
	if links := overseerrLinks(t, s, server); len(links) != 0 {
		t.Fatal("configuration change kept links", links)
	}
}

func TestProfileOverseerrReturnsSanitizedRequestsAndScopedLinks(t *testing.T) {
	f := newOverseerrFixture(t)
	a, s, token, member, user := roleReadFixture(t)
	server := overseerrServer(t, a, token, f)
	service := seedPlexAccount(t, s, server, "1001", "viewer")
	unlinked := seedPlexAccount(t, s, server, "1002", "plex-1002")
	owner, _ := s.Authenticate(t.Context(), token)
	if err := s.LinkServiceAccounts(t.Context(), owner.UUID, user, []string{service, unlinked}); err != nil {
		t.Fatal(err)
	}
	if err := a.refreshOverseerrLinks(t.Context(), server); err != nil {
		t.Fatal(err)
	}
	w := apiRequest(a, "GET", "/api/users/"+service+"/overseerr", token, nil, nil)
	body := w.Body.String()
	for _, secret := range []string{f.key, "private-plex-token", "viewer@example.invalid\",\"plexToken", "plexUrl", "evil.invalid", "credits"} {
		if strings.Contains(body, secret) {
			t.Fatal("leaked", secret, body)
		}
	}
	var payload struct {
		Data []struct {
			Linked   bool                  `json:"is_linked"`
			UserID   *int64                `json:"overseerr_user_id"`
			Requests []overseerrRequestDTO `json:"requests"`
			Error    *string               `json:"request_error"`
			Server   string                `json:"server_name"`
		} `json:"data"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &payload) != nil || len(payload.Data) != 1 {
		t.Fatal(w.Code, body)
	}
	item := payload.Data[0]
	if !item.Linked || *item.UserID != 5 || len(item.Requests) != 1 || item.Requests[0].Media.Details == nil || item.Requests[0].Media.Details.Title != "The Fixture" || item.Requests[0].Media.Details.PosterPath != "/poster.jpg" || item.Requests[0].Media.Details.BackdropPath != "" || item.Server == "" {
		t.Fatal(body)
	}
	// The human profile lists every owned Plex account, linked or not.
	w = apiRequest(a, "GET", "/api/users/"+user+"/overseerr", token, nil, nil)
	if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil || len(payload.Data) != 2 {
		t.Fatal(w.Body.String())
	}
	// Upstream request failures become fixed text; link status is still returned.
	f.mu.Lock()
	f.mode = "requests_down"
	f.mu.Unlock()
	w = apiRequest(a, "GET", "/api/users/"+service+"/overseerr", token, nil, nil)
	if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil || payload.Data[0].Error == nil || strings.Contains(w.Body.String(), "private upstream failure") || !payload.Data[0].Linked {
		t.Fatal(w.Body.String())
	}
	// Removing the administrator grant removes access.
	activityExec(t, s, "DELETE FROM admin_privileges WHERE user_uuid=?", user)
	if w := apiRequest(a, "GET", "/api/users/"+service+"/overseerr", member, nil, nil); w.Code != 403 {
		t.Fatal("non-administrator read Overseerr data", w.Code)
	}
}

func TestOverseerrTestConnectionReportsWithoutPersisting(t *testing.T) {
	f := newOverseerrFixture(t)
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	a.ProviderHTTP = &http.Client{Transport: providerTransport(func(r *http.Request) (*http.Response, error) {
		if strings.HasPrefix(r.URL.String(), f.server.URL) {
			return http.DefaultTransport.RoundTrip(r)
		}
		return jsonResponse(r, 200, `{"ServerName":"Fixture","Version":"10"}`), nil
	})}
	w := apiRequest(a, "POST", "/api/providers/jellyfin/test-connection", token, map[string]any{"url": "http://jellyfin.fixture.invalid", "api_key": "k", "overseerr_enabled": true, "overseerr_url": f.server.URL, "overseerr_api_key": f.key}, nil)
	check := responseData(t, w)["overseerr"].(map[string]any)
	if w.Code != 200 || check["success"] != true || !strings.Contains(check["message"].(string), "3 users visible") {
		t.Fatal(w.Code, w.Body.String())
	}
	var count int
	s.reader.QueryRow("SELECT count(*) FROM overseerr_links").Scan(&count)
	if count != 0 {
		t.Fatal("test persisted links")
	}
	w = apiRequest(a, "POST", "/api/providers/jellyfin/test-connection", token, map[string]any{"url": "http://jellyfin.fixture.invalid", "api_key": "k", "overseerr_enabled": true, "overseerr_url": f.server.URL, "overseerr_api_key": "wrong"}, nil)
	if check = responseData(t, w)["overseerr"].(map[string]any); check["success"] != false || check["message"] != "Invalid Overseerr API key" {
		t.Fatal(w.Body.String())
	}
}

// A real Plex users sync through the HTTP API refreshes Overseerr links from
// the committed accounts (plex.tv traffic is intercepted by the fixture).
func TestPlexUsersSyncRefreshesOverseerrLinks(t *testing.T) {
	upstream, client, _ := extendedProviderFixture(t, "plex")
	f := newOverseerrFixture(t)
	f.users = []map[string]any{{"id": 12, "plexId": 2, "displayName": "Reader"}, {"id": 13, "plexId": 3, "displayName": "Pending"}}
	a, s := testApp(t)
	plexOnly := client.Transport
	a.ProviderHTTP = &http.Client{Transport: providerTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host == strings.TrimPrefix(f.server.URL, "http://") {
			return http.DefaultTransport.RoundTrip(r)
		}
		return plexOnly.RoundTrip(r)
	})}
	token, _ := bootstrapOwner(t, a)
	id := createManagedServer(t, a, token, "plex", upstream.URL+"/proxy")
	path := "/api/servers/" + strconv.FormatInt(id, 10)
	if w := apiRequest(a, "PATCH", path, token, map[string]any{"overseerr_enabled": true, "overseerr_url": f.server.URL, "overseerr_api_key": f.key}, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := apiRequest(a, "POST", path+"/sync", token, nil, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if links := overseerrLinks(t, s, id); len(links) != 2 || links["2"] != 12 || links["3"] != 13 {
		t.Fatal("links after sync", links)
	}
	// An Overseerr outage never fails the Plex sync and keeps prior links.
	f.mu.Lock()
	f.mode = "no_page_info"
	f.mu.Unlock()
	if w := apiRequest(a, "POST", path+"/sync", token, nil, nil); w.Code != 200 {
		t.Fatal("Overseerr failure failed the Plex sync", w.Code)
	}
	if links := overseerrLinks(t, s, id); len(links) != 2 {
		t.Fatal("failed refresh dropped links", links)
	}
}

func TestOverseerrRequestActionInspectsWritesOnceAndVerifies(t *testing.T) {
	f := newOverseerrFixture(t)
	a, s, token, member, user := roleReadFixture(t)
	server := overseerrServer(t, a, token, f)
	seedPlexAccount(t, s, server, "1001", "viewer")
	if err := a.refreshOverseerrLinks(t.Context(), server); err != nil {
		t.Fatal(err)
	}
	path := func(action string) string {
		return "/api/servers/" + strconv.FormatInt(server, 10) + "/overseerr/requests/41/" + action
	}
	posts := func() int { f.mu.Lock(); defer f.mu.Unlock(); return f.posts }
	if w := apiRequest(a, "POST", path("approve"), token, nil, nil); w.Code != 200 || responseData(t, w)["outcome"] != "approved" || posts() != 1 {
		t.Fatal(w.Code, w.Body.String())
	}
	// Already approved: inspected, not written again.
	if w := apiRequest(a, "POST", path("approve"), token, nil, nil); w.Code != 200 || responseData(t, w)["outcome"] != "unchanged" || posts() != 1 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := apiRequest(a, "POST", path("decline"), token, nil, nil); w.Code != 409 || posts() != 1 {
		t.Fatal("non-pending request changed", w.Code)
	}
	for _, tc := range []struct {
		mode string
		code int
	}{{"drop_action", 503}, {"ignore_action", 409}} {
		f.mu.Lock()
		f.status, f.mode = 1, tc.mode
		f.mu.Unlock()
		before := posts()
		if w := apiRequest(a, "POST", path("approve"), token, nil, nil); w.Code != tc.code || posts() != before+1 {
			t.Fatal(tc.mode, w.Code, w.Body.String())
		}
	}
	f.mu.Lock()
	f.status, f.mode, f.requester = 1, "", 7
	f.mu.Unlock()
	before := posts()
	if w := apiRequest(a, "POST", path("approve"), token, nil, nil); w.Code != 409 || posts() != before {
		t.Fatal("unlinked requester's request changed", w.Code)
	}
	for _, bad := range []string{"/api/servers/" + strconv.FormatInt(server, 10) + "/overseerr/requests/41/delete", "/api/servers/" + strconv.FormatInt(server, 10) + "/overseerr/requests/0/approve"} {
		if w := apiRequest(a, "POST", bad, token, nil, nil); w.Code != 400 {
			t.Fatal(bad, w.Code)
		}
	}
	var outcomes []string
	rows, _ := s.reader.Query("SELECT json_extract(details,'$.outcome') FROM audit_events WHERE action LIKE 'overseerr.request.%' ORDER BY id")
	for rows.Next() {
		var outcome string
		rows.Scan(&outcome)
		outcomes = append(outcomes, outcome)
	}
	rows.Close()
	if strings.Join(outcomes, ",") != "approved,unchanged,unknown,failed" {
		t.Fatal(outcomes)
	}
	activityExec(t, s, "DELETE FROM admin_privileges WHERE user_uuid=?", user)
	if w := apiRequest(a, "POST", path("approve"), member, nil, nil); w.Code != 403 {
		t.Fatal("non-administrator changed a request", w.Code)
	}
}
