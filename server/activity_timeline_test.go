package main

import (
	"encoding/json"
	"fmt"
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
	Poster      string  `json:"poster_url"`
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
		activityExec(t, s, `INSERT INTO history_imports(server_id,entry_key,account_id,viewed_at,media_type,title,grandparent_title,imported_at) VALUES(?,?,?,?,'episode',?,'A Show',?)`, server, p.key, p.account, at(p.hour), p.title, at(p.hour))
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

// An imported play's poster is a signed, administrator-only link; the stored
// Plex path never reaches the browser, and a viewer's own timeline has none.
func TestIdentityTimelinePlexPosters(t *testing.T) {
	a, s, token, viewer, local := timelineFixture(t)
	activityExec(t, s, "UPDATE provider_settings SET enabled=1 WHERE provider_id='plex'")
	activityExec(t, s, "UPDATE history_imports SET poster_item='20',poster_path='/library/metadata/20/thumb/1' WHERE entry_key='/h/4'")
	_, page := readTimeline(t, a, token, local, url.Values{"scope": {"all"}, "source": {"plex"}})
	var rowid int64
	_ = s.reader.QueryRow("SELECT rowid FROM history_imports WHERE entry_key='/h/4'").Scan(&rowid)
	if len(page.Items) != 3 || !strings.HasPrefix(page.Items[0].Poster, fmt.Sprintf("/api/activity/imported-history-images/%d?", rowid)) || page.Items[1].Poster != "" {
		t.Fatalf("posters %+v", page.Items)
	}
	poster := page.Items[0].Poster
	// The fixture server is offline: the link resolves, the fetch fails upstream.
	if got := apiRequest(a, "GET", poster, "", nil, nil).Code; got != 502 {
		t.Fatal("poster source not resolved", got)
	}
	if got := apiRequest(a, "GET", strings.Replace(poster, "imported-history-images", "history-images", 1), "", nil, nil).Code; got != 403 {
		t.Fatal("a Plex poster link worked as a MUM one", got)
	}
	if _, own := readTimeline(t, a, viewer, local, url.Values{"scope": {"own"}, "source": {"plex"}}); own.Items[0].Poster != "" {
		t.Fatal("a viewer got a poster link", own.Items[0].Poster)
	}
	// A link signed for the viewer's own session is refused: posters are for administrators.
	var session string
	if err := s.reader.QueryRow("SELECT id FROM app_sessions WHERE user_uuid=?", local).Scan(&session); err != nil {
		t.Fatal(err)
	}
	if got := apiRequest(a, "GET", a.signedImageURL(importedHistoryPosterPurpose, "/api/activity/imported-history-images", session, rowid, time.Now()), "", nil, nil).Code; got != 403 {
		t.Fatal("a viewer's link was served", got)
	}
}

// A person with accounts on several services gets one picker entry per
// service; each imported play is marked with its service, Audiobookshelf
// plays carry how far and how long, and every service's poster is a signed
// administrator link.
func TestIdentityTimelineServiceSources(t *testing.T) {
	a, s, token, _, local := timelineFixture(t)
	owner, _ := s.Authenticate(t.Context(), token)
	activityExec(t, s, "UPDATE provider_settings SET enabled=1 WHERE provider_id IN ('jellyfin','audiobookshelf')")
	var servers []int64
	for _, kind := range []string{"jellyfin", "audiobookshelf"} {
		activityExec(t, s, `INSERT INTO media_servers(server_nickname,service_type,url,api_key) VALUES(?,?,?,'fixture-secret')`, kind+"++", kind, "http://"+kind+".test")
		var server int64
		_ = s.reader.QueryRow("SELECT id FROM media_servers WHERE server_nickname=?", kind+"++").Scan(&server)
		servers = append(servers, server)
		if err := s.LinkServiceAccounts(t.Context(), owner.UUID, local, []string{seedExternalService(t, s, server, kind+"-user")}); err != nil {
			t.Fatal(err)
		}
	}
	at := "2026-11-01T06:00:00.000000000Z"
	activityExec(t, s, `INSERT INTO history_imports(server_id,entry_key,account_id,viewed_at,media_type,title,poster_item,poster_path,imported_at) VALUES(?,'a1','jellyfin-user',?,'movie','Jelly film','m1','tag1',?)`, servers[0], at, at)
	activityExec(t, s, `INSERT INTO history_imports(server_id,entry_key,account_id,viewed_at,media_type,title,parent_title,position_seconds,duration_seconds,imported_at) VALUES(?,'ses','audiobookshelf-user','2026-11-01T05:00:00.000000000Z','book','A Book','An Author',90,3600,?)`, servers[1], at)

	w := apiRequest(a, "GET", "/api/activity/identities/"+local+"/timeline?scope=all", token, nil, nil)
	var out struct {
		Data struct {
			Sources []string `json:"sources"`
			Items   []struct {
				Source   string  `json:"source"`
				ID       string  `json:"id"`
				Title    string  `json:"title"`
				Position *string `json:"position_ticks"`
				Duration *string `json:"duration_ticks"`
				Poster   string  `json:"poster_url"`
			} `json:"items"`
		}
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil || w.Code != 200 {
		t.Fatal(w.Code, err)
	}
	if got := strings.Join(out.Data.Sources, ","); got != "plex,jellyfin,audiobookshelf" {
		t.Fatal("sources", got)
	}
	jelly, book := out.Data.Items[0], out.Data.Items[1]
	if jelly.Source != "jellyfin" || !strings.HasPrefix(jelly.ID, "jellyfin-") || !strings.HasPrefix(jelly.Poster, "/api/activity/imported-history-images/") {
		t.Fatalf("jellyfin row %+v", jelly)
	}
	if book.Source != "audiobookshelf" || book.Position == nil || *book.Position != "900000000" || book.Duration == nil || *book.Duration != "36000000000" || book.Poster != "" {
		t.Fatalf("audiobookshelf row %+v", book)
	}
	// The fixture server is offline: the link resolves, the fetch fails upstream.
	if got := apiRequest(a, "GET", jelly.Poster, "", nil, nil).Code; got != 502 {
		t.Fatal("jellyfin poster source not resolved", got)
	}
	_, page := readTimeline(t, a, token, local, url.Values{"scope": {"all"}, "source": {"jellyfin"}})
	if got := timelineTitles(page); got != "jellyfin:Jelly film" || page.Source != "jellyfin" {
		t.Fatal("jellyfin only", got)
	}
	// Paging past a Jellyfin play keeps its place.
	timelinePageSize = 1
	t.Cleanup(func() { timelinePageSize = 100 })
	_, first := readTimeline(t, a, token, local, url.Values{"scope": {"all"}})
	if first.Next == nil {
		t.Fatal("no next page")
	}
	_, second := readTimeline(t, a, token, local, url.Values{"scope": {"all"}, "before": {*first.Next}})
	if timelineTitles(first)+"|"+timelineTitles(second) != "jellyfin:Jelly film|audiobookshelf:A Book" {
		t.Fatal("paging", timelineTitles(first), timelineTitles(second))
	}
	// A removed account keeps its history, and its service stays in the picker.
	activityExec(t, s, "UPDATE service_accounts SET removed_at=? WHERE external_user_id='jellyfin-user'", at)
	timelinePageSize = 100
	w = apiRequest(a, "GET", "/api/activity/identities/"+local+"/timeline?scope=all", token, nil, nil)
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil || strings.Join(out.Data.Sources, ",") != "plex,jellyfin,audiobookshelf" || out.Data.Items[0].Source != "jellyfin" {
		t.Fatal("removed account", err, out.Data.Sources)
	}
	if code, _ := readTimeline(t, a, token, local, url.Values{"scope": {"all"}, "source": {"kavita"}}); code != 400 {
		t.Fatal("unknown source accepted", code)
	}
}

// Each MUM play carries Tautulli's columns: platform, product, player, IP,
// stop time, paused and watched time. The player (a device name) and the IP
// are for administrators only; imported plays record none of them.
func TestIdentityTimelinePlaybackDetails(t *testing.T) {
	a, s, token, viewer, local := timelineFixture(t)
	activityExec(t, s, `UPDATE media_activity_history SET platform='Chrome',device_name='Living room',ip_address='172.56.183.189',play_method='direct_play',
		last_seen_at='2026-11-01T03:10:00.000000000Z',paused_seconds=60,ended_at='2026-11-01T03:11:00.000000000Z',end_reason='not_observed' WHERE title='MUM three'`)
	type details struct {
		Title    string  `json:"title"`
		Platform *string `json:"platform"`
		Client   *string `json:"client"`
		Player   *string `json:"player"`
		IP       *string `json:"ip_address"`
		Stopped  *string `json:"stopped_at"`
		Paused   *string `json:"paused_seconds"`
		Watched  *string `json:"watched_seconds"`
	}
	read := func(token, scope string) map[string]details {
		w := apiRequest(a, "GET", "/api/activity/identities/"+local+"/timeline?scope="+scope, token, nil, nil)
		var out struct{ Data struct{ Items []details } }
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &out) != nil {
			t.Fatal(w.Code, w.Body.String())
		}
		rows := map[string]details{}
		for _, item := range out.Data.Items {
			rows[item.Title] = item
		}
		return rows
	}
	text := func(v *string) string {
		if v == nil {
			return "<nil>"
		}
		return *v
	}
	admin := read(token, "all")
	got := admin["MUM three"]
	if text(got.Platform) != "Chrome" || text(got.Client) != "Plex Web" || text(got.Player) != "Living room" || text(got.IP) != "172.56.183.189" ||
		text(got.Stopped) != "2026-11-01T03:10:00.000000000Z" || text(got.Paused) != "60" || text(got.Watched) != "540" {
		t.Fatalf("admin row %+v", got)
	}
	// A play recorded before paused time was kept has no paused time; its
	// watched time is counted as the Profile tab counts it.
	if old := admin["MUM one"]; old.Paused != nil || text(old.Stopped) != "2026-11-01T01:00:00.000000000Z" || text(old.Watched) != "0" || old.Platform != nil {
		t.Fatalf("older row %+v", old)
	}
	if imported := admin["Plex four"]; imported.Platform != nil || imported.Player != nil || imported.IP != nil || imported.Stopped != nil || imported.Paused != nil || imported.Watched != nil {
		t.Fatalf("imported row %+v", imported)
	}
	own := read(viewer, "own")["MUM three"]
	if own.Player != nil || own.IP != nil || text(own.Platform) != "Chrome" || text(own.Watched) != "540" {
		t.Fatalf("own row %+v", own)
	}
}
