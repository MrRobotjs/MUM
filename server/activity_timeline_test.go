package main

import (
	"encoding/json"
	"net/url"
	"strings"
	"testing"
	"time"
)

type timelineTestItem struct {
	Source      string  `json:"source"`
	ID          string  `json:"id"`
	Title       string  `json:"title"`
	ParentTitle *string `json:"parent_title"`
	PlayedAt    string  `json:"played_at"`
	Client      *string `json:"client"`
	Position    *string `json:"position_ticks"`
}

type timelineTestPage struct {
	Actor  string             `json:"actor_uuid"`
	Target string             `json:"target_uuid"`
	Source string             `json:"source"`
	Items  []timelineTestItem `json:"items"`
	Next   *string            `json:"next_before"`
}

func readTimeline(t *testing.T, a *App, token, target string, query url.Values) (int, timelineTestPage) {
	t.Helper()
	w := apiRequest(a, "GET", "/api/activity/identities/"+target+"/timeline?"+query.Encode(), token, nil, nil)
	var out struct{ Data timelineTestPage }
	if w.Code == 200 {
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
	}
	return w.Code, out.Data
}

// timelineFixture: a local user owning Plex account 42, with MUM plays at
// hours 1 and 3 and imported Plex plays at hours 2, 3 (a tie) and 4, plus an
// imported play of another account that must not appear.
func timelineFixture(t *testing.T) (*App, *Store, string, string, string) {
	t.Helper()
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	owner, _ := s.Authenticate(t.Context(), token)
	activityExec(t, s, `INSERT INTO media_servers(server_nickname,service_type,url,api_key) VALUES('Plex++','plex','http://plex.test','fixture-secret')`)
	var server int64
	_ = s.reader.QueryRow("SELECT id FROM media_servers WHERE server_nickname='Plex++'").Scan(&server)
	seedExternalService(t, s, server, "77") // someone else on the same server
	service := seedExternalService(t, s, server, "42")
	hash, _ := hashPassword("a-strong-member-password")
	local, err := s.CreateAccount(t.Context(), owner.UUID, "viewer", hash, false)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.LinkServiceAccounts(t.Context(), owner.UUID, local, []string{service}); err != nil {
		t.Fatal(err)
	}
	base := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	at := func(hour int) string { return utcTimestamp(base.Add(time.Duration(hour) * time.Hour)) }
	for i, hour := range []int{1, 3} {
		activityExec(t, s, `INSERT INTO media_activity_history(server_id,external_session_id,service_uuid,owner_uuid,item_id,media_type,title,first_seen_at,last_seen_at,paused,client) VALUES(?,?,?,?,?,?,?,?,?,0,'Plex Web')`,
			server, "s"+at(hour), service, local, "item", "movie", []string{"MUM one", "MUM three"}[i], at(hour), at(hour))
	}
	for _, p := range []struct {
		key, account, title string
		hour                int
	}{{"/h/2", "42", "Plex two", 2}, {"/h/3", "42", "Plex three", 3}, {"/h/4", "42", "Plex four", 4}, {"/h/9", "77", "Someone else", 5}} {
		activityExec(t, s, `INSERT INTO plex_history_imports(server_id,history_key,account_id,viewed_at,media_type,title,grandparent_title,imported_at) VALUES(?,?,?,?,'episode',?,'A Show',?)`, server, p.key, p.account, at(p.hour), p.title, at(p.hour))
	}
	w := apiRequest(a, "POST", "/api/auth/login", "", map[string]any{"username": "viewer", "password": "a-strong-member-password"}, nil)
	return a, s, token, responseData(t, w)["access_token"].(string), local
}

func timelineTitles(page timelineTestPage) string {
	var out []string
	for _, item := range page.Items {
		out = append(out, item.Source+":"+item.Title)
	}
	return strings.Join(out, ",")
}

func TestIdentityTimelineMergesMUMAndPlexPlays(t *testing.T) {
	a, _, token, _, local := timelineFixture(t)
	code, page := readTimeline(t, a, token, local, url.Values{"scope": {"all"}})
	if code != 200 {
		t.Fatal(code)
	}
	// Newest first; at the same time a Plex play comes before a MUM play.
	if got := timelineTitles(page); got != "plex:Plex four,plex:Plex three,mum:MUM three,plex:Plex two,mum:MUM one" {
		t.Fatal(got)
	}
	plex, mum := page.Items[0], page.Items[2]
	if plex.ParentTitle == nil || *plex.ParentTitle != "A Show" || plex.Client != nil || plex.Position != nil || plex.PlayedAt != "2026-11-01T04:00:00.000000000Z" {
		t.Fatalf("plex row %+v", plex)
	}
	if mum.Client == nil || *mum.Client != "Plex Web" {
		t.Fatalf("mum row %+v", mum)
	}
	for source, want := range map[string]string{"mum": "mum:MUM three,mum:MUM one", "plex": "plex:Plex four,plex:Plex three,plex:Plex two"} {
		_, page := readTimeline(t, a, token, local, url.Values{"scope": {"all"}, "source": {source}})
		if got := timelineTitles(page); got != want || page.Source != source {
			t.Fatal(source, got)
		}
	}
}

func TestIdentityTimelinePagesWithoutGapsOrRepeats(t *testing.T) {
	timelinePageSize = 2
	t.Cleanup(func() { timelinePageSize = 100 })
	a, _, token, _, local := timelineFixture(t)
	var seen []string
	query := url.Values{"scope": {"all"}}
	for pages := 0; pages < 5; pages++ {
		code, page := readTimeline(t, a, token, local, query)
		if code != 200 || len(page.Items) > 2 {
			t.Fatal(code, page)
		}
		for _, item := range page.Items {
			seen = append(seen, item.Source+":"+item.Title)
		}
		if page.Next == nil {
			break
		}
		query.Set("before", *page.Next)
	}
	if got := strings.Join(seen, ","); got != "plex:Plex four,plex:Plex three,mum:MUM three,plex:Plex two,mum:MUM one" {
		t.Fatal(got)
	}
}

func TestIdentityTimelineAuthority(t *testing.T) {
	a, s, token, viewer, local := timelineFixture(t)
	if code, page := readTimeline(t, a, viewer, local, url.Values{"scope": {"own"}}); code != 200 || len(page.Items) != 5 || page.Actor != local {
		t.Fatal("own timeline", code, timelineTitles(page))
	}
	if code, _ := readTimeline(t, a, viewer, local, url.Values{"scope": {"all"}}); code != 403 {
		t.Fatal("a viewer used the administrator scope", code)
	}
	owner, _ := s.Authenticate(t.Context(), token)
	other, err := s.CreateAccount(t.Context(), owner.UUID, "other-viewer", "fixture-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	if code, _ := readTimeline(t, a, viewer, other, url.Values{"scope": {"own"}}); code != 403 {
		t.Fatal("read another person's timeline", code)
	}
	for _, bad := range []url.Values{{"source": {"both"}}, {"before": {"yesterday"}}, {"before": {"2026-11-01T04:00:00.000000000Z_x_1"}}, {"before": {"2026-11-01T04:00:00Z_p_1"}}, {"extra": {"1"}}} {
		bad.Set("scope", "all")
		if code, _ := readTimeline(t, a, token, local, bad); code != 400 {
			t.Fatal("bad query accepted", bad, code)
		}
	}
}
