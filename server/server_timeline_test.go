package main

import (
	"encoding/json"
	"net/url"
	"strconv"
	"strings"
	"testing"
)

type serverTimelineTestPage struct {
	Actor   string  `json:"actor_uuid"`
	User    *string `json:"user"`
	Server  *string `json:"server_id"`
	Records string  `json:"records"`
	Servers []struct {
		ID      string `json:"server_id"`
		History bool   `json:"history"`
	} `json:"servers"`
	People []struct {
		UUID string `json:"uuid"`
		Name string `json:"name"`
	} `json:"people"`
	Items []struct {
		Source     string `json:"source"`
		ID         string `json:"id"`
		Title      string `json:"title"`
		PersonUUID string `json:"person_uuid"`
		PersonName string `json:"person_name"`
	} `json:"items"`
	Next *string `json:"next_before"`
}

func readServerTimeline(t *testing.T, a *App, token string, query url.Values) (int, serverTimelineTestPage) {
	t.Helper()
	w := apiRequest(a, "GET", "/api/activity/timeline?"+query.Encode(), token, nil, nil)
	var out struct{ Data serverTimelineTestPage }
	if w.Code == 200 {
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
	}
	return w.Code, out.Data
}

func serverTimelineTitles(page serverTimelineTestPage) string {
	var out []string
	for _, item := range page.Items {
		out = append(out, item.Source+":"+item.Title)
	}
	return strings.Join(out, ",")
}

func TestServerTimelineAllServersAndServiceNameFallback(t *testing.T) {
	a, s, token, viewer, local := timelineFixture(t)
	activityExec(t, s, `INSERT INTO media_servers(server_nickname,service_type,url,api_key) VALUES('Jelly++','jellyfin','http://jelly.test','fixture-secret')`)
	var server int64
	if err := s.reader.QueryRow(`SELECT id FROM media_servers WHERE server_nickname='Jelly++'`).Scan(&server); err != nil {
		t.Fatal(err)
	}
	service := seedExternalService(t, s, server, "jf-user")
	activityExec(t, s, `UPDATE service_accounts SET external_username='Jelly Viewer' WHERE uuid=?`, service)
	activityExec(t, s, `UPDATE user_accounts SET local_username=NULL WHERE uuid=?`, local)
	activityExec(t, s, `INSERT INTO media_activity_history(server_id,external_session_id,service_uuid,owner_uuid,item_id,media_type,title,first_seen_at,last_seen_at,paused) VALUES(?,?,?,?,?,'episode','Jelly play','2026-11-01T06:00:00.000000000Z','2026-11-01T06:01:00.000000000Z',0)`, server, "jf-session", service, local, "jf-item")
	code, page := readServerTimeline(t, a, token, url.Values{"server": {"all"}})
	if code != 200 || page.Server == nil || *page.Server != "all" || len(page.Items) != 7 || page.Items[0].Title != "Jelly play" || page.Items[0].PersonName != "Jelly Viewer" {
		t.Fatalf("combined history %d %+v", code, page)
	}
	if code, recorded := readServerTimeline(t, a, token, url.Values{"server": {"all"}, "records": {"mum"}}); code != 200 || len(recorded.Items) != 3 {
		t.Fatalf("combined MUM filter %d %+v", code, recorded)
	}
	if code, mine := readServerTimeline(t, a, token, url.Values{"server": {"all"}, "user": {local}}); code != 200 || len(mine.Items) != 6 {
		t.Fatalf("combined user filter %d %+v", code, mine)
	}
	timelinePageSize = 2
	t.Cleanup(func() { timelinePageSize = 100 })
	query := url.Values{"server": {"all"}}
	seen := map[string]bool{}
	for range 5 {
		code, result := readServerTimeline(t, a, token, query)
		if code != 200 {
			t.Fatal(code)
		}
		for _, item := range result.Items {
			if seen[item.ID] {
				t.Fatalf("duplicate %s", item.ID)
			}
			seen[item.ID] = true
		}
		if result.Next == nil {
			break
		}
		query.Set("before", *result.Next)
	}
	if len(seen) != 7 {
		t.Fatalf("paging skipped plays: %v", seen)
	}
	if w := apiRequest(a, "POST", "/api/activity/servers/all/timeline/delete", viewer, map[string]any{"ids": []string{page.Items[0].ID}}, nil); w.Code != 403 {
		t.Fatal("non-admin deleted combined history", w.Code)
	}
	w := apiRequest(a, "POST", "/api/activity/servers/all/timeline/delete", token, map[string]any{"ids": []string{page.Items[0].ID, page.Items[1].ID}}, nil)
	if w.Code != 200 || responseData(t, w)["deleted"] != float64(2) {
		t.Fatalf("combined delete %d %s", w.Code, w.Body.String())
	}
}

// A server's history shows everyone's plays on it, recorded and imported,
// newest first, each with who played it; a person filter narrows it to them.
func TestServerTimelineEveryonesPlays(t *testing.T) {
	a, s, token, _, local := timelineFixture(t)
	var server int64
	_ = s.reader.QueryRow("SELECT id FROM media_servers WHERE server_nickname='Plex++'").Scan(&server)
	id := strconv.FormatInt(server, 10)

	// Without a server, the one with the newest play is shown.
	code, page := readServerTimeline(t, a, token, url.Values{})
	if code != 200 || page.Server == nil || *page.Server != id || page.User != nil || len(page.Servers) != 1 {
		t.Fatalf("default server %d %+v", code, page)
	}
	if got := serverTimelineTitles(page); got != "plex:Someone else,plex:Plex four,plex:Plex three,mum:MUM three,plex:Plex two,mum:MUM one" {
		t.Fatal(got)
	}
	// Each play names its person: the MUM account for the linked server
	// account, the server account itself otherwise.
	names := map[string]string{}
	for _, item := range page.Items {
		names[item.Title] = item.PersonUUID + "/" + item.PersonName
	}
	if !strings.HasPrefix(names["MUM one"], local+"/viewer") || !strings.HasPrefix(names["Plex two"], local+"/viewer") || strings.HasPrefix(names["Someone else"], local) {
		t.Fatalf("people on plays %v", names)
	}
	if len(page.People) != 2 {
		t.Fatalf("people %+v", page.People)
	}

	// One person: only their plays; the people list stays whole.
	code, mine := readServerTimeline(t, a, token, url.Values{"server": {id}, "user": {local}})
	if code != 200 || mine.User == nil || *mine.User != local || len(mine.People) != 2 {
		t.Fatalf("person filter %d %+v", code, mine)
	}
	if got := serverTimelineTitles(mine); got != "plex:Plex four,plex:Plex three,mum:MUM three,plex:Plex two,mum:MUM one" {
		t.Fatal(got)
	}
	// Records and paging work as on a person's history.
	if _, recorded := readServerTimeline(t, a, token, url.Values{"server": {id}, "records": {"mum"}}); serverTimelineTitles(recorded) != "mum:MUM three,mum:MUM one" {
		t.Fatal(serverTimelineTitles(recorded))
	}
	timelinePageSize = 4
	t.Cleanup(func() { timelinePageSize = 100 })
	_, first := readServerTimeline(t, a, token, url.Values{"server": {id}})
	if first.Next == nil || len(first.Items) != 4 {
		t.Fatalf("first page %+v", first)
	}
	_, second := readServerTimeline(t, a, token, url.Values{"server": {id}, "before": {*first.Next}})
	if serverTimelineTitles(second) != "plex:Plex two,mum:MUM one" || second.Next != nil {
		t.Fatal(serverTimelineTitles(second))
	}

	if code, _ := readServerTimeline(t, a, token, url.Values{"server": {"999999"}}); code != 404 {
		t.Fatal("unknown server", code)
	}
	for _, bad := range []url.Values{{"server": {"abc"}}, {"user": {"someone"}}, {"records": {"both"}}, {"types": {"games"}}, {"scope": {"all"}}, {"before": {"yesterday"}}} {
		if code, _ := readServerTimeline(t, a, token, bad); code != 400 {
			t.Fatal("bad query accepted", bad, code)
		}
	}
	timelinePageSize = 100
	// The person's own history still shows all of their plays.
	_, person := readTimeline(t, a, token, local, url.Values{"scope": {"all"}})
	if len(person.Items) != 5 {
		t.Fatal(timelineTitles(person))
	}
}

// Only administrators read or delete a server's history; a delete must stay
// on the server it names, and every play must exist there.
func TestServerTimelineAuthorityAndDelete(t *testing.T) {
	a, s, token, viewer, _ := timelineFixture(t)
	var server int64
	_ = s.reader.QueryRow("SELECT id FROM media_servers WHERE server_nickname='Plex++'").Scan(&server)
	id := strconv.FormatInt(server, 10)
	if code, _ := readServerTimeline(t, a, viewer, url.Values{"server": {id}}); code != 403 {
		t.Fatal("a viewer read a server's history", code)
	}
	_, page := readServerTimeline(t, a, token, url.Values{"server": {id}})
	var someone, mumOne string
	for _, item := range page.Items {
		switch item.Title {
		case "Someone else":
			someone = item.ID
		case "MUM one":
			mumOne = item.ID
		}
	}
	del := func(token string, server string, ids ...string) int {
		return apiRequest(a, "POST", "/api/activity/servers/"+server+"/timeline/delete", token, map[string]any{"ids": ids}, nil).Code
	}
	if code := del(viewer, id, someone); code != 403 {
		t.Fatal("a viewer deleted plays", code)
	}
	// Another server: the plays aren't there, so nothing is deleted.
	activityExec(t, s, `INSERT INTO media_servers(server_nickname,service_type,url,api_key) VALUES('Other','plex','http://other.test','fixture-secret')`)
	var other int64
	_ = s.reader.QueryRow("SELECT id FROM media_servers WHERE server_nickname='Other'").Scan(&other)
	if code := del(token, strconv.FormatInt(other, 10), someone); code != 404 {
		t.Fatal("deleted a play through another server", code)
	}
	if code := del(token, id, someone, mumOne); code != 200 {
		t.Fatal("delete", code)
	}
	_, after := readServerTimeline(t, a, token, url.Values{"server": {id}})
	if got := serverTimelineTitles(after); strings.Contains(got, "Someone else") || strings.Contains(got, "MUM one") || len(after.Items) != 4 {
		t.Fatal(got)
	}
	for _, bad := range [][]string{{}, {"mum-0"}, {"film-1"}, {someone, someone}} {
		if code := del(token, id, bad...); code != 400 {
			t.Fatal("bad delete accepted", bad, code)
		}
	}
	var audit string
	_ = s.reader.QueryRow("SELECT details FROM audit_events WHERE action='activity.history.delete' ORDER BY id DESC LIMIT 1").Scan(&audit)
	if !strings.Contains(audit, `"server_id":`+id) || strings.Contains(audit, "target_uuid") {
		t.Fatal("audit", audit)
	}
}
