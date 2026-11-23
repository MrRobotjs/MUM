package main

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"testing"
)

type serverAccountsPage struct {
	ServerID   int64  `json:"server_id"`
	Live       bool   `json:"live"`
	Records    string `json:"records"`
	TotalItems int    `json:"total_items"`
	TotalPages int    `json:"total_pages"`
	Items      []struct {
		UUID              string  `json:"uuid"`
		Username          string  `json:"username"`
		DuplicateUsername bool    `json:"duplicate_username"`
		Active            bool    `json:"is_active"`
		LastStreamed      *string `json:"last_streamed_at"`
		LastPlayed        *struct {
			Title     string `json:"title"`
			Source    string `json:"source"`
			PosterURL string `json:"poster_url"`
			Link      *struct {
				Library int64  `json:"library_id"`
				Media   int64  `json:"media_id"`
				Episode *int64 `json:"episode_id"`
			} `json:"link"`
		} `json:"last_played"`
		LastIP       *string `json:"last_ip"`
		LastPlatform *string `json:"last_platform"`
		LastPlayer   *string `json:"last_player"`
		Plays        int     `json:"plays"`
		Watch        *int64  `json:"watch_seconds"`
		Linked       *struct {
			UUID string `json:"uuid"`
			Name string `json:"name"`
		} `json:"linked_profile"`
	} `json:"items"`
}

// serverAccountsFixture: Plex++ with accounts 42 (owned by "viewer") and 77,
// and another server whose plays must never count. Account 42 has two MUM
// plays (the newer without an IP) and two imported plays; 77 has one import.
func serverAccountsFixture(t *testing.T) (*App, *Store, string, int64) {
	t.Helper()
	a, s, token, viewer, local := timelineFixture(t)
	_ = viewer
	var server int64
	_ = s.reader.QueryRow("SELECT id FROM media_servers WHERE server_nickname='Plex++'").Scan(&server)
	activityExec(t, s, `UPDATE media_activity_history SET ip_address='172.56.183.189',platform='Chrome',device_name='Living room',last_seen_at='2026-11-01T01:30:00.000000000Z',paused_seconds=0 WHERE title='MUM one'`)
	activityExec(t, s, `UPDATE media_activity_history SET platform='Roku',last_seen_at='2026-11-01T03:10:00.000000000Z',paused_seconds=0 WHERE title='MUM three'`)
	activityExec(t, s, "DELETE FROM history_imports WHERE entry_key='/h/3'")
	// Another server's plays for the same person are not this server's.
	activityExec(t, s, `INSERT INTO media_servers(server_nickname,service_type,url,api_key) VALUES('Other','plex','http://other.test','k')`)
	var other int64
	_ = s.reader.QueryRow("SELECT id FROM media_servers WHERE server_nickname='Other'").Scan(&other)
	activityExec(t, s, `INSERT INTO history_imports(server_id,entry_key,account_id,viewed_at,title,imported_at) VALUES(?,'/o/1','42','2026-11-05T00:00:00.000000000Z','Elsewhere','2026-11-05T00:00:00.000000000Z')`, other)
	_ = local
	return a, s, token, server
}

func readServerAccounts(t *testing.T, a *App, token string, server int64, query url.Values) (int, serverAccountsPage) {
	t.Helper()
	w := apiRequest(a, "GET", fmt.Sprintf("/api/servers/%d/accounts?%s", server, query.Encode()), token, nil, nil)
	var out struct{ Data serverAccountsPage }
	if w.Code == 200 {
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
	}
	return w.Code, out.Data
}

func TestServerAccountsActivityOnThisServer(t *testing.T) {
	a, _, token, server := serverAccountsFixture(t)
	code, page := readServerAccounts(t, a, token, server, url.Values{"sort": {"plays_desc"}})
	if code != 200 || !page.Live || page.Records != "all" || page.TotalItems != 2 || len(page.Items) != 2 {
		t.Fatalf("page %d %+v", code, page)
	}
	top := page.Items[0]
	if top.Username != "synced" || top.Plays != 4 || top.LastStreamed == nil || *top.LastStreamed != "2026-11-01T04:00:00.000000000Z" ||
		top.LastPlayed == nil || top.LastPlayed.Title != "Plex four" || top.LastPlayed.Source != "plex" {
		t.Fatalf("top %+v", top)
	}
	// The newest MUM play has no IP: the last known one is shown.
	if top.LastIP == nil || *top.LastIP != "172.56.183.189" || top.LastPlatform == nil || *top.LastPlatform != "Roku" || top.LastPlayer == nil || *top.LastPlayer != "Living room" {
		t.Fatalf("last known %+v", top)
	}
	if top.Watch == nil || *top.Watch != 30*60+10*60 {
		t.Fatalf("watch %v", top.Watch)
	}
	if top.Linked == nil || top.Linked.Name != "viewer" {
		t.Fatalf("linked %+v", top.Linked)
	}
	if page.Items[1].Plays != 1 {
		t.Fatalf("second %+v", page.Items[1])
	}
	// Recorded by MUM only.
	_, mum := readServerAccounts(t, a, token, server, url.Values{"records": {"mum"}, "sort": {"plays_desc"}})
	if mum.Items[0].Plays != 2 || mum.Items[0].LastPlayed.Title != "MUM three" || mum.Items[1].Plays != 0 || mum.Items[1].LastStreamed != nil {
		t.Fatalf("mum %+v", mum.Items)
	}
	// From server history: no MUM-only columns.
	_, imported := readServerAccounts(t, a, token, server, url.Values{"records": {"server"}, "sort": {"plays_desc"}})
	if imported.Items[0].Plays != 2 || imported.Items[0].LastIP != nil || imported.Items[0].Watch != nil || imported.Items[0].LastPlatform != nil {
		t.Fatalf("server %+v", imported.Items)
	}
}

func TestServerAccountsSearchSortPagingAndAccess(t *testing.T) {
	a, s, token, server := serverAccountsFixture(t)
	activityExec(t, s, "UPDATE service_accounts SET external_username='zed',external_email='zed@example.test' WHERE external_user_id='77'")
	if _, page := readServerAccounts(t, a, token, server, url.Values{"search": {"ZED@"}}); len(page.Items) != 1 || page.Items[0].Username != "zed" {
		t.Fatalf("search %+v", page.Items)
	}
	// The linked profile's name is not searched: the page is about this server's accounts.
	if _, page := readServerAccounts(t, a, token, server, url.Values{"search": {"viewer"}}); len(page.Items) != 0 {
		t.Fatalf("search matched the linked profile %+v", page.Items)
	}
	if _, page := readServerAccounts(t, a, token, server, url.Values{"search": {"%"}}); len(page.Items) != 0 {
		t.Fatalf("wildcard matched %+v", page.Items)
	}
	_, first := readServerAccounts(t, a, token, server, url.Values{"sort": {"username_asc"}, "page_size": {"1"}})
	_, second := readServerAccounts(t, a, token, server, url.Values{"sort": {"username_asc"}, "page_size": {"1"}, "page": {"2"}})
	if first.TotalPages != 2 || first.Items[0].Username != "synced" || second.Items[0].Username != "zed" {
		t.Fatalf("paging %+v %+v", first, second)
	}
	if _, page := readServerAccounts(t, a, token, server, url.Values{"sort": {"last_streamed_asc"}}); page.Items[0].Username != "synced" {
		t.Fatalf("last streamed order %+v", page.Items)
	}
	// Every column sorts across all pages; a missing value comes last both ways.
	activityExec(t, s, `UPDATE service_accounts SET access_expires_at='2027-01-01T00:00:00.000000000Z',allowed_library_ids='["1","2"]' WHERE external_user_id='77'`)
	activityExec(t, s, `UPDATE service_accounts SET external_email='a@example.test',allowed_library_ids='["1"]' WHERE external_user_id='42'`)
	for _, c := range []struct {
		sort  string
		first string
	}{{"email_asc", "synced"}, {"email_desc", "zed"}, {"last_played_asc", "synced"}, {"last_played_desc", "zed"},
		{"last_ip_asc", "synced"}, {"last_ip_desc", "synced"}, {"last_platform_desc", "synced"}, {"last_player_asc", "synced"},
		{"libraries_desc", "zed"}, {"expires_asc", "zed"}, {"expires_desc", "zed"}} {
		code, page := readServerAccounts(t, a, token, server, url.Values{"sort": {c.sort}})
		if code != 200 || len(page.Items) != 2 || page.Items[0].Username != c.first {
			t.Fatalf("%s: %d %+v", c.sort, code, page.Items)
		}
	}
	for _, bad := range []url.Values{{"records": {"both"}}, {"sort": {"email"}}, {"page": {"0"}}, {"page_size": {"201"}}, {"extra": {"1"}}} {
		if code, _ := readServerAccounts(t, a, token, server, bad); code != 400 {
			t.Fatal("accepted", bad, code)
		}
	}
	if code, _ := readServerAccounts(t, a, token, 9999, url.Values{}); code != 404 {
		t.Fatal("unknown server", code)
	}
	w := apiRequest(a, "POST", "/api/auth/login", "", map[string]any{"username": "viewer", "password": "a-strong-member-password"}, nil)
	if code, _ := readServerAccounts(t, a, responseData(t, w)["access_token"].(string), server, url.Values{}); code != 403 {
		t.Fatal("a member read the server's accounts", code)
	}
}

func TestServerAccountsLastPlayedPosterAndPage(t *testing.T) {
	a, s, token, server := serverAccountsFixture(t)
	activityExec(t, s, "INSERT INTO media_libraries(server_id,external_id,name) VALUES(?,'lib','Shows')", server)
	var library, show, episode, movie int64
	_ = s.reader.QueryRow("SELECT id FROM media_libraries WHERE server_id=? AND external_id='lib'", server).Scan(&library)
	activityExec(t, s, "INSERT INTO media_items(library_id,server_id,external_id,title,item_type) VALUES(?,?,'show1','A Show','show')", library, server)
	activityExec(t, s, "INSERT INTO media_items(library_id,server_id,external_id,parent_id,title,item_type) VALUES(?,?,'ep4','show1','Plex four','episode')", library, server)
	activityExec(t, s, "INSERT INTO media_items(library_id,server_id,external_id,title,item_type) VALUES(?,?,'movie1','Someone else','movie')", library, server)
	_ = s.reader.QueryRow("SELECT id FROM media_items WHERE external_id='show1'").Scan(&show)
	_ = s.reader.QueryRow("SELECT id FROM media_items WHERE external_id='ep4'").Scan(&episode)
	_ = s.reader.QueryRow("SELECT id FROM media_items WHERE external_id='movie1'").Scan(&movie)
	activityExec(t, s, "UPDATE history_imports SET item_id='ep4',poster_item='show1',poster_path='/library/metadata/show1/thumb' WHERE entry_key='/h/4'")
	activityExec(t, s, "UPDATE history_imports SET item_id='movie1' WHERE entry_key='/h/9'")

	_, page := readServerAccounts(t, a, token, server, url.Values{"sort": {"plays_desc"}})
	top, other := page.Items[0].LastPlayed, page.Items[1].LastPlayed
	// An episode opens its show's episode page and carries the History tab's poster link.
	if top == nil || top.Link == nil || top.Link.Library != library || top.Link.Media != show || top.Link.Episode == nil || *top.Link.Episode != episode ||
		!strings.HasPrefix(top.PosterURL, "/api/activity/imported-history-images/") {
		t.Fatalf("episode %+v", top)
	}
	// A top-level item opens its own page; no poster is stored for it.
	if other == nil || other.Link == nil || other.Link.Media != movie || other.Link.Episode != nil || other.PosterURL != "" {
		t.Fatalf("movie %+v", other)
	}
	// A play whose item isn't catalogued has no page.
	if _, mum := readServerAccounts(t, a, token, server, url.Values{"records": {"mum"}, "sort": {"plays_desc"}}); mum.Items[0].LastPlayed == nil || mum.Items[0].LastPlayed.Link != nil {
		t.Fatalf("uncatalogued %+v", mum.Items[0].LastPlayed)
	}
	// The poster link's signature is accepted (the fixture server can't serve
	// the image itself, so the image lookup ends in 404 rather than 401/403).
	if w := apiRequest(a, "GET", top.PosterURL, "", nil, nil); w.Code == 403 || w.Code == 401 {
		t.Fatalf("poster link refused: %d %s", w.Code, w.Body.String())
	}
	if w := apiRequest(a, "GET", strings.Replace(top.PosterURL, "s=", "s=x", 1), "", nil, nil); w.Code != 403 && w.Code != 401 {
		t.Fatalf("a tampered poster link was accepted: %d", w.Code)
	}
}

func TestServerAccountUsernameLookupScopesAndRejectsAmbiguity(t *testing.T) {
	a, s, token, server := serverAccountsFixture(t)
	var name string
	if err := s.reader.QueryRow("SELECT external_username FROM service_accounts WHERE server_id=? AND external_username IS NOT NULL LIMIT 1", server).Scan(&name); err != nil {
		t.Fatal(err)
	}
	activityExec(t, s, `UPDATE service_accounts SET external_username='unique-test-name' WHERE uuid=(SELECT uuid FROM service_accounts WHERE server_id=? LIMIT 1)`, server)
	name = "unique-test-name"
	lookup := func() int {
		return apiRequest(a, "GET", fmt.Sprintf("/api/servers/%d/accounts/lookup?username=%s", server, url.QueryEscape(name)), token, nil, nil).Code
	}
	if got := apiRequest(a, "GET", fmt.Sprintf("/api/servers/%d/accounts/lookup?username=%s", server, url.QueryEscape(name)), "", nil, nil).Code; got != 401 {
		t.Fatalf("anonymous lookup %d", got)
	}
	var other int64
	if err := s.reader.QueryRow("SELECT id FROM media_servers WHERE server_nickname='Other'").Scan(&other); err != nil {
		t.Fatal(err)
	}
	if got := apiRequest(a, "GET", fmt.Sprintf("/api/servers/%d/accounts/lookup?username=%s", other, url.QueryEscape(name)), token, nil, nil).Code; got != 404 {
		t.Fatalf("wrong server lookup %d", got)
	}
	wrongServer := apiRequest(a, "GET", fmt.Sprintf("/api/servers/%d/accounts/lookup?username=%s&id=invalid", server, url.QueryEscape(name)), token, nil, nil)
	if wrongServer.Code != 400 {
		t.Fatalf("invalid id: %d", wrongServer.Code)
	}
	if got := lookup(); got != 200 {
		t.Fatalf("lookup %d", got)
	}
	activityExec(t, s, `UPDATE service_accounts SET external_username=? WHERE uuid=(SELECT uuid FROM service_accounts WHERE server_id=? AND external_username!=? LIMIT 1)`, name, server, name)
	w := apiRequest(a, "GET", fmt.Sprintf("/api/servers/%d/accounts/lookup?username=%s", server, url.QueryEscape(name)), token, nil, nil)
	if w.Code != 200 {
		t.Fatalf("ambiguous lookup: %d %s", w.Code, w.Body.String())
	}
	var reply struct {
		Data struct {
			Matches []struct {
				UUID string `json:"uuid"`
			} `json:"matches"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &reply); err != nil || len(reply.Data.Matches) != 2 {
		t.Fatalf("choices: %s %v", w.Body.String(), err)
	}
	code, page := readServerAccounts(t, a, token, server, url.Values{"search": {name}, "page_size": {"1"}})
	if code != 200 || len(page.Items) != 1 || !page.Items[0].DuplicateUsername {
		t.Fatalf("duplicate across pages: %+v", page.Items)
	}
	pick := reply.Data.Matches[0].UUID
	w = apiRequest(a, "GET", fmt.Sprintf("/api/servers/%d/accounts/lookup?username=%s&id=%s", server, url.QueryEscape(name), pick), token, nil, nil)
	if w.Code != 200 || !strings.Contains(w.Body.String(), pick) {
		t.Fatalf("selection: %d %s", w.Code, w.Body.String())
	}
	w = apiRequest(a, "GET", fmt.Sprintf("/api/servers/%d/accounts/lookup?username=%s&id=11111111-1111-4111-8111-111111111119", server, url.QueryEscape(name)), token, nil, nil)
	if w.Code != 404 {
		t.Fatalf("unrelated id accepted: %d %s", w.Code, w.Body.String())
	}
}
