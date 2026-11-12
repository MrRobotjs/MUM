package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestActivityParserCapturesSeriesAndAlbumParents(t *testing.T) {
	parse := func(item map[string]any) (activitySession, error) {
		row := activityFixtureRow()
		row["NowPlayingItem"] = item
		body, _ := json.Marshal([]any{row})
		snapshot, err := parseActivitySnapshot("jellyfin", body)
		if err != nil {
			return activitySession{}, err
		}
		return snapshot.Sessions[0], nil
	}
	episode, err := parse(map[string]any{"Id": "ep1", "Name": "Pilot", "Type": "Episode", "SeriesId": "show1", "SeriesName": "The Show"})
	if err != nil || episode.Parent != "show1" || episode.ParentTitle != "The Show" {
		t.Fatal(episode, err)
	}
	track, err := parse(map[string]any{"Id": "t1", "Name": "Song", "Type": "Audio", "AlbumId": "album1", "Album": "Record"})
	if err != nil || track.Parent != "album1" || track.ParentTitle != "Record" {
		t.Fatal(track, err)
	}
	// A movie never gains a parent, and a parent title without an ID is dropped.
	movie, err := parse(map[string]any{"Id": "m1", "Name": "Film", "Type": "Movie", "SeriesId": "ignored"})
	if err != nil || movie.Parent != "" {
		t.Fatal(movie, err)
	}
	orphan, err := parse(map[string]any{"Id": "ep2", "Name": "Pilot", "Type": "Episode", "SeriesName": "No ID"})
	if err != nil || orphan.Parent != "" || orphan.ParentTitle != "" {
		t.Fatal(orphan, err)
	}
	for name, item := range map[string]map[string]any{
		"non-string ID":       {"Id": "ep3", "Name": "Pilot", "Type": "Episode", "SeriesId": 7},
		"case-colliding keys": {"Id": "ep4", "Name": "Pilot", "Type": "Episode", "SeriesId": "a", "seriesid": "b"},
		"padded ID":           {"Id": "ep5", "Name": "Pilot", "Type": "Episode", "SeriesId": " show1"},
	} {
		if _, err := parse(item); err == nil {
			t.Fatal(name, "accepted")
		}
	}
}

func TestLibraryStatsAndActivityAttributeThroughTheCatalogue(t *testing.T) {
	f := newCatalogueFixture(t, 3)
	f.upstream.mu.Lock()
	f.upstream.items = append(f.upstream.items, map[string]any{"Id": "show1", "Name": "The Show", "Type": "Series"})
	f.upstream.mu.Unlock()
	if w := apiRequest(f.a, "POST", f.path("/sync"), f.token, nil, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var server int64
	f.s.reader.QueryRow("SELECT server_id FROM media_libraries WHERE id=?", f.library).Scan(&server)
	activityExec(t, f.s, "INSERT INTO identities(uuid,kind) VALUES('svc-viewer','service')")
	activityExec(t, f.s, "INSERT INTO service_accounts(uuid,server_id,external_user_id,external_username,created_at,updated_at) VALUES('svc-viewer',?,'viewer-id','viewer',?,?)", server, utcTimestamp(time.Now()), utcTimestamp(time.Now()))
	now := time.Now().UTC()
	observe := func(session, item, kind, title, parent, parentTitle string, started time.Time, seconds int) {
		activityExec(t, f.s, `INSERT INTO media_activity_history(server_id,external_session_id,service_uuid,item_id,media_type,title,first_seen_at,last_seen_at,ended_at,end_reason,paused,parent_item_id,parent_title)
		 VALUES(?,?,'svc-viewer',?,?,?,?,?,?,'not_observed',0,nullif(?,''),nullif(?,''))`, server, session, item, kind, title, utcTimestamp(started), utcTimestamp(started.Add(time.Duration(seconds)*time.Second)), utcTimestamp(started.Add(time.Duration(seconds)*time.Second)), parent, parentTitle)
	}
	observe("s1", "a0000", "Movie", "Movie 0000", "", "", now.Add(-3*time.Hour), 3600)
	observe("s2", "a0000", "Movie", "Movie 0000", "", "", now.Add(-2*time.Hour), 1800)
	observe("s3", "ep1", "Episode", "Pilot", "show1", "The Show", now.Add(-time.Hour), 600)
	observe("s4", "ep2", "Episode", "Unattributed", "", "", now.Add(-time.Hour), 600) // no parent: not attributable
	observe("s5", "elsewhere", "Movie", "Not in library", "", "", now.Add(-time.Hour), 600)
	observe("s6", "a0001", "Movie", "Movie 0001", "", "", now.AddDate(0, 0, -40), 1200) // outside 30 days

	stats := responseData(t, apiRequest(f.a, "GET", f.path("/stats?days=30"), f.token, nil, nil))
	s := stats["stats"].(map[string]any)
	if s["total_streams"].(float64) != 3 || s["unique_users"].(float64) != 1 || s["total_duration"].(float64) != 6000 || s["average_session_length"].(float64) != 2000 || stats["catalogue_synced"] != true {
		t.Fatal(stats)
	}
	trending := s["trending_content"].([]any)
	first, second := trending[0].(map[string]any), trending[1].(map[string]any)
	if len(trending) != 2 || first["title"] != "Movie 0000" || first["streams"].(float64) != 2 || second["title"] != "The Show" {
		t.Fatal(trending)
	}
	chart := stats["chart_data"].([]any)
	last := chart[len(chart)-1].(map[string]any)
	// The observations start one to three hours ago, which can straddle UTC
	// midnight, so check the window totals rather than one day's bucket.
	var plays, minutes float64
	for _, point := range chart {
		plays += point.(map[string]any)["plays"].(float64)
		minutes += point.(map[string]any)["time"].(float64)
	}
	if len(chart) != 30 || last["label"] != now.Format("2006-01-02") || plays != 3 || minutes != 100 {
		t.Fatal(len(chart), last, plays, minutes)
	}
	if wide := responseData(t, apiRequest(f.a, "GET", f.path("/stats?days=90"), f.token, nil, nil)); wide["stats"].(map[string]any)["total_streams"].(float64) != 4 {
		t.Fatal(wide["stats"])
	}

	w := apiRequest(f.a, "GET", f.path("/activity?days=30&page=1&page_size=2"), f.token, nil, nil)
	var activity struct {
		Data []map[string]any `json:"data"`
		Meta struct {
			Pagination struct {
				Total int `json:"total_items"`
				Pages int `json:"total_pages"`
			} `json:"pagination"`
		} `json:"meta"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &activity); err != nil || w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if activity.Meta.Pagination.Total != 3 || activity.Meta.Pagination.Pages != 2 || len(activity.Data) != 2 {
		t.Fatal(activity.Meta)
	}
	episode, movie := activity.Data[0], activity.Data[1]
	if episode["media_title"] != "Pilot" || episode["grandparent_title"] != "The Show" || episode["user_display_name"] != "viewer" || episode["duration_seconds"].(float64) != 600 || episode["thumb_path"] != nil {
		t.Fatal(episode)
	}
	if thumb, _ := movie["thumb_path"].(string); !strings.HasPrefix(thumb, "/api/media/images/") {
		t.Fatal("attributed movie lacks a signed poster", movie)
	}

	// Window, page and authority checks.
	for _, path := range []string{"/stats?days=0", "/stats?days=366", "/activity?page_size=101", "/activity?page=0"} {
		if w := apiRequest(f.a, "GET", f.path(path), f.token, nil, nil); w.Code != 400 {
			t.Fatal(path, w.Code)
		}
	}
	if w := apiRequest(f.a, "GET", "/api/libraries/999/stats", f.token, nil, nil); w.Code != 404 {
		t.Fatal("unknown library", w.Code)
	}
	owner, _ := f.s.Authenticate(t.Context(), f.token)
	member, err := f.s.CreateAccount(t.Context(), owner.UUID, "member", "encoded", false)
	if err != nil {
		t.Fatal(err)
	}
	tokens, err := f.s.issueSession(t.Context(), member, false)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/stats", "/activity"} {
		if w := apiRequest(f.a, "GET", f.path(path), tokens.Access, nil, nil); w.Code != 403 {
			t.Fatal(path, w.Code)
		}
	}
	// A purged catalogue attributes nothing and reports itself unsynced.
	if w := apiRequest(f.a, "POST", f.path("/purge"), f.token, nil, nil); w.Code != 200 {
		t.Fatal(w.Code)
	}
	empty := responseData(t, apiRequest(f.a, "GET", f.path("/stats"), f.token, nil, nil))
	if empty["stats"].(map[string]any)["total_streams"].(float64) != 0 || empty["catalogue_synced"] != false {
		t.Fatal(fmt.Sprint(empty))
	}
}

func TestActivityCaptureStoresEpisodeSeries(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	// The handler is replaced once the seeded service account ID is known.
	upstream := httptest.NewServer(http.NotFoundHandler())
	defer upstream.Close()
	server := createManagedServer(t, a, token, "jellyfin", upstream.URL)
	service := seedService(t, s, server)
	upstream.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		row := activityFixtureRow()
		row["UserId"] = service
		row["NowPlayingItem"] = map[string]any{"Id": "ep1", "Name": "Pilot", "Type": "Episode", "RunTimeTicks": int64(100000000), "SeriesId": "show1", "SeriesName": "The Show"}
		_ = json.NewEncoder(w).Encode([]any{row})
	})
	owner, _ := s.Authenticate(t.Context(), token)
	if result, err := a.captureProviderActivity(t.Context(), owner.UUID, token, server); err != nil || result.Started != 1 {
		t.Fatal(result, err)
	}
	var parent, title string
	if err := s.reader.QueryRow("SELECT parent_item_id,parent_title FROM media_activity_history WHERE server_id=? AND item_id='ep1'", server).Scan(&parent, &title); err != nil || parent != "show1" || title != "The Show" {
		t.Fatal(parent, title, err)
	}
}
