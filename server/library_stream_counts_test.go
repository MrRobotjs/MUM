package main

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"
)

func TestCatalogueStreamCountsAndItemActivity(t *testing.T) {
	f := newCatalogueFixture(t, 3)
	f.upstream.mu.Lock()
	f.upstream.items = append(f.upstream.items, map[string]any{"Id": "show1", "Name": "The Show", "Type": "Series"})
	f.upstream.episodes = map[string][]map[string]any{"show1": {
		{"Id": "ep1", "Name": "Pilot", "Type": "Episode", "SeriesId": "show1", "ParentIndexNumber": 1, "IndexNumber": 1},
		{"Id": "ep2", "Name": "Second", "Type": "Episode", "SeriesId": "show1", "ParentIndexNumber": 1, "IndexNumber": 2},
	}}
	f.upstream.mu.Unlock()
	if w := apiRequest(f.a, "POST", f.path("/sync"), f.token, nil, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	ids := map[string]int64{}
	rows, _ := f.s.reader.Query("SELECT external_id,id FROM media_items WHERE library_id=?", f.library)
	for rows.Next() {
		var external string
		var id int64
		rows.Scan(&external, &id)
		ids[external] = id
	}
	rows.Close()
	if w := apiRequest(f.a, "POST", f.path(fmt.Sprintf("/media/%d/episodes/sync", ids["show1"])), f.token, nil, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var server int64
	f.s.reader.QueryRow("SELECT server_id FROM media_libraries WHERE id=?", f.library).Scan(&server)
	activityExec(t, f.s, "INSERT INTO identities(uuid,kind) VALUES('svc-viewer','service')")
	activityExec(t, f.s, "INSERT INTO service_accounts(uuid,server_id,external_user_id,external_username,created_at,updated_at) VALUES('svc-viewer',?,'viewer-id','viewer',?,?)", server, utcTimestamp(time.Now()), utcTimestamp(time.Now()))
	now := time.Now().UTC()
	n := 0
	observe := func(item, parent string, started time.Time) {
		n++
		activityExec(t, f.s, `INSERT INTO media_activity_history(server_id,external_session_id,service_uuid,item_id,media_type,title,first_seen_at,last_seen_at,ended_at,end_reason,paused,parent_item_id,parent_title)
		 VALUES(?,?,'svc-viewer',?,'Movie',?,?,?,?,'not_observed',0,nullif(?,''),nullif(?,''))`, server, fmt.Sprintf("s%d", n), item, "Title "+item, utcTimestamp(started), utcTimestamp(started.Add(time.Minute)), utcTimestamp(started.Add(time.Minute)), parent, map[bool]string{true: "The Show"}[parent != ""])
	}
	observe("a0000", "", now.Add(-3*time.Hour))
	observe("a0000", "", now.Add(-2*time.Hour))
	observe("ep1", "show1", now.Add(-90*time.Minute))
	observe("ep1", "show1", now.Add(-time.Hour))
	observe("ep2", "show1", now.Add(-30*time.Minute))
	observe("a0001", "", now.AddDate(0, 0, -40)) // counted, but outside a 30-day activity window
	observe("elsewhere", "", now.Add(-time.Hour))
	activityExec(t, f.s, `INSERT INTO media_servers(server_nickname,service_type,url,api_key) VALUES('Other','emby','http://127.0.0.1:9','key')`)
	activityExec(t, f.s, `INSERT INTO media_activity_history(server_id,external_session_id,service_uuid,item_id,media_type,title,first_seen_at,last_seen_at,paused)
	 VALUES((SELECT id FROM media_servers WHERE server_nickname='Other'),'other','svc-viewer','a0000','Movie','Same ID, other server',?,?,0)`, utcTimestamp(now), utcTimestamp(now))

	want := map[string]int64{"a0000": 2, "a0001": 1, "a0002": 0, "show1": 3}
	list := f.list(t, "page_size=10")
	for _, item := range list.Data {
		if item.StreamCount != want[item.External] {
			t.Fatal("stream count", item.External, item.StreamCount)
		}
	}
	order := []string{}
	for _, item := range f.list(t, "sort_by=total_streams_desc").Data {
		order = append(order, item.External)
	}
	if fmt.Sprint(order) != "[show1 a0000 a0001 a0002]" {
		t.Fatal(order)
	}
	detail := responseData(t, apiRequest(f.a, "GET", f.path(fmt.Sprintf("/media/%d", ids["show1"])), f.token, nil, nil))
	if detail["stream_count"].(float64) != 3 {
		t.Fatal(detail["stream_count"])
	}

	var episodes struct {
		Data struct {
			Episodes []struct {
				Title   string `json:"title"`
				Streams int64  `json:"stream_count"`
			} `json:"episodes"`
		} `json:"data"`
	}
	w := apiRequest(f.a, "GET", f.path(fmt.Sprintf("/media/%d/episodes?sort_by=total_streams_asc", ids["show1"])), f.token, nil, nil)
	if err := json.Unmarshal(w.Body.Bytes(), &episodes); err != nil || len(episodes.Data.Episodes) != 2 {
		t.Fatal(w.Code, w.Body.String())
	}
	if e := episodes.Data.Episodes; e[0].Title != "Second" || e[0].Streams != 1 || e[1].Title != "Pilot" || e[1].Streams != 2 {
		t.Fatal(e)
	}

	activity := func(item int64, days int) []map[string]any {
		t.Helper()
		w := apiRequest(f.a, "GET", f.path(fmt.Sprintf("/media/%d/activity?days=%d", item, days)), f.token, nil, nil)
		var out struct {
			Data []map[string]any `json:"data"`
			Meta struct {
				Pagination struct {
					Total int `json:"total_items"`
				} `json:"pagination"`
			} `json:"meta"`
		}
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &out) != nil || out.Meta.Pagination.Total != len(out.Data) {
			t.Fatal(w.Code, w.Body.String())
		}
		return out.Data
	}
	show := activity(ids["show1"], 30)
	if len(show) != 3 || show[0]["media_title"] != "Title ep2" || show[2]["media_title"] != "Title ep1" || show[0]["grandparent_title"] != "The Show" || show[0]["user_display_name"] != "viewer" {
		t.Fatal(show)
	}
	if movie := activity(ids["a0000"], 30); len(movie) != 2 {
		t.Fatal(movie)
	}
	if len(activity(ids["a0001"], 30)) != 0 || len(activity(ids["a0001"], 90)) != 1 {
		t.Fatal("activity window not applied")
	}
	var episode int64
	f.s.reader.QueryRow("SELECT id FROM media_items WHERE library_id=? AND external_id='ep1'", f.library).Scan(&episode)
	for _, item := range []int64{episode, 999999} {
		if w := apiRequest(f.a, "GET", f.path(fmt.Sprintf("/media/%d/activity", item)), f.token, nil, nil); w.Code != 404 {
			t.Fatal(item, w.Code)
		}
	}
	if w := apiRequest(f.a, "GET", f.path(fmt.Sprintf("/media/%d/activity?days=0", ids["show1"])), f.token, nil, nil); w.Code != 400 {
		t.Fatal(w.Code)
	}

	// An episode's own page: its details with its show, and its own plays.
	episodePath := func(suffix string) string {
		return f.path(fmt.Sprintf("/media/%d/episodes/%d%s", ids["show1"], episode, suffix))
	}
	detail = responseData(t, apiRequest(f.a, "GET", episodePath(""), f.token, nil, nil))
	show1 := detail["show"].(map[string]any)
	if detail["id"].(float64) != float64(episode) || detail["title"] != "Pilot" || detail["item_type"] != "episode" || detail["season_number"].(float64) != 1 || detail["episode_number"].(float64) != 1 ||
		detail["stream_count"].(float64) != 2 || show1["id"].(float64) != float64(ids["show1"]) || show1["title"] != "The Show" || detail["library"].(map[string]any)["id"].(float64) != float64(f.library) {
		t.Fatal(detail)
	}
	w = apiRequest(f.a, "GET", episodePath("/activity?days=30"), f.token, nil, nil)
	var plays struct {
		Data []map[string]any `json:"data"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &plays) != nil || len(plays.Data) != 2 || plays.Data[0]["media_title"] != "Title ep1" {
		t.Fatal(w.Code, w.Body.String())
	}
	// An episode is only found under its own show, and a show is not an episode.
	for _, path := range []string{
		fmt.Sprintf("/media/%d/episodes/%d", ids["a0000"], episode),
		fmt.Sprintf("/media/%d/episodes/%d/activity", ids["a0000"], episode),
		fmt.Sprintf("/media/%d/episodes/%d", ids["show1"], ids["show1"]),
		fmt.Sprintf("/media/%d/episodes/%d/activity", ids["show1"], ids["a0000"]),
	} {
		if w := apiRequest(f.a, "GET", f.path(path), f.token, nil, nil); w.Code != 404 && w.Code != 409 {
			t.Fatal(path, w.Code, w.Body.String())
		}
	}
}
