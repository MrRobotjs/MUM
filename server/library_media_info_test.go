package main

import (
	"fmt"
	"testing"
	"time"
)

// The Media Info tab lists each library file with its saved details, sorts on
// the server with missing values last, searches shows by name and counts plays
// from MUM's recordings and imported history.
func TestLibraryMediaInfoListsFilesWithPlays(t *testing.T) {
	f := activityReadFixture(t)
	activityExec(t, f.store, "INSERT INTO media_libraries(server_id,external_id,name) VALUES(?,'lib','Mixed')", f.server)
	var library int64
	if err := f.store.reader.QueryRow("SELECT id FROM media_libraries WHERE server_id=? AND external_id='lib'", f.server).Scan(&library); err != nil {
		t.Fatal(err)
	}
	insert := func(external, parent, title, kind, media string) {
		activityExec(t, f.store, "INSERT INTO media_items(library_id,server_id,external_id,parent_id,title,item_type,added_at,media_info,season_number,episode_number) VALUES(?,?,?,nullif(?,''),?,?,'2026-01-01T00:00:00Z',nullif(?,''),1,1)",
			library, f.server, external, parent, title, kind, media)
	}
	insert("m1", "", "Alpha", "movie", `{"container":"MKV","bitrate_kbps":9000,"video_resolution":"1080p"}`)
	insert("m2", "", "Beta", "movie", `{"container":"MP4","bitrate_kbps":5000,"video_resolution":"SD"}`)
	insert("s1", "", "Show", "show", "")
	insert("e1", "s1", "Pilot", "episode", `{"video_resolution":"4K"}`)
	now := time.Now().UTC()
	activityExec(t, f.store, `INSERT INTO media_activity_history(server_id,external_session_id,service_uuid,item_id,media_type,title,first_seen_at,last_seen_at,paused) VALUES(?,'played',?,'m2','movie','Beta',?,?,0)`,
		f.server, f.service, utcTimestamp(now.Add(-2*time.Hour)), utcTimestamp(now.Add(-time.Hour)))
	activityExec(t, f.store, `INSERT INTO history_imports(server_id,entry_key,account_id,viewed_at,media_type,item_id,title,imported_at) VALUES(?,'k1','viewer',?,'movie','m2','Beta',?)`,
		f.server, utcTimestamp(now.AddDate(0, 0, -3)), utcTimestamp(now))

	read := func(token, query string) (int, []map[string]any) {
		t.Helper()
		w := apiRequest(f.app, "GET", fmt.Sprintf("/api/libraries/%d/media-info?%s", library, query), token, nil, nil)
		if w.Code != 200 {
			return w.Code, nil
		}
		var items []map[string]any
		for _, v := range responseData(t, w)["items"].([]any) {
			items = append(items, v.(map[string]any))
		}
		return w.Code, items
	}
	titles := func(items []map[string]any) (out []string) {
		for _, it := range items {
			out = append(out, it["title"].(string))
		}
		return
	}
	if code, items := read(f.ownerToken, ""); code != 200 || fmt.Sprint(titles(items)) != "[Alpha Beta Pilot]" {
		t.Fatal("shows aren't files and titles sort by show", code, titles(items))
	}
	if _, items := read(f.ownerToken, "sort=bitrate&order=desc"); fmt.Sprint(titles(items)) != "[Alpha Beta Pilot]" {
		t.Fatal("bitrate sort or missing-last order", titles(items))
	}
	if _, items := read(f.ownerToken, "sort=video_resolution&order=desc"); fmt.Sprint(titles(items)) != "[Pilot Alpha Beta]" {
		t.Fatal("resolution sorts by height", titles(items))
	}
	_, items := read(f.ownerToken, "sort=plays&order=desc")
	if items[0]["title"] != "Beta" || items[0]["plays"] != float64(2) || items[0]["last_played_at"] == nil || items[1]["last_played_at"] != nil {
		t.Fatal("plays count recordings and imports", items)
	}
	_, items = read(f.ownerToken, "search=show")
	if len(items) != 1 || items[0]["parent_title"] != "Show" || items[0]["parent_id"] == nil || items[0]["media_info"].(map[string]any)["video_resolution"] != "4K" {
		t.Fatal("search finds a show's episodes", items)
	}
	if _, items = read(f.ownerToken, "search=mp4"); fmt.Sprint(titles(items)) != "[Beta]" {
		t.Fatal("search matches the container", titles(items))
	}
	if _, items = read(f.ownerToken, "search=4k"); fmt.Sprint(titles(items)) != "[Pilot]" {
		t.Fatal("search matches the resolution, ignoring case", titles(items))
	}
	if _, items = read(f.ownerToken, "page_size=1&page=2"); fmt.Sprint(titles(items)) != "[Beta]" {
		t.Fatal("paging", titles(items))
	}
	for _, query := range []string{"sort=summary", "order=sideways", "page_size=101", "page=0"} {
		if code, _ := read(f.ownerToken, query); code != 400 {
			t.Fatalf("%s accepted with %d", query, code)
		}
	}
	if code, _ := read("", ""); code != 401 {
		t.Fatal("media info read without signing in", code)
	}
}
