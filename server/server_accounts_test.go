package main

import (
	"encoding/json"
	"fmt"
	"net/url"
	"testing"
)

type serverAccountsPage struct {
	ServerID   int64  `json:"server_id"`
	Live       bool   `json:"live"`
	Records    string `json:"records"`
	TotalItems int    `json:"total_items"`
	TotalPages int    `json:"total_pages"`
	Items      []struct {
		UUID         string  `json:"uuid"`
		Username     string  `json:"username"`
		Active       bool    `json:"is_active"`
		LastStreamed *string `json:"last_streamed_at"`
		LastPlayed   *struct {
			Title  string `json:"title"`
			Source string `json:"source"`
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
