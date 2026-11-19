package main

import (
	"encoding/json"
	"strconv"
	"strings"
	"testing"
	"time"
)

type activityStatsBody struct {
	Data struct {
		Days   int `json:"days"`
		Totals struct {
			Plays   int64 `json:"plays"`
			Seconds int64 `json:"seconds"`
			People  int64 `json:"people"`
			Titles  int64 `json:"titles"`
		} `json:"totals"`
		Sections []struct {
			Kind  string `json:"kind"`
			Items []struct {
				Server   int64   `json:"server_id"`
				Title    string  `json:"title"`
				Subtitle *string `json:"subtitle"`
				Plays    int64   `json:"plays"`
				Seconds  int64   `json:"seconds"`
			} `json:"items"`
		} `json:"sections"`
		Platforms []struct {
			Name  string `json:"name"`
			Plays int64  `json:"plays"`
		} `json:"platforms"`
		Unreported []struct {
			Name string `json:"name"`
			Type string `json:"service_type"`
		} `json:"unreported"`
		Servers []struct {
			ID   int64  `json:"server_id"`
			Name string `json:"name"`
			Type string `json:"service_type"`
		} `json:"servers"`
		Imported []struct {
			Name       string  `json:"name"`
			ImportedAt *string `json:"imported_at"`
		} `json:"imported"`
	} `json:"data"`
}

// The dashboard's Activity card covers every server type: MUM's recordings
// for the servers it monitors (movies, shows by series, music by album and
// platforms), imported history for servers it can't monitor (audiobooks),
// and the servers that report nothing.
func TestActivityStatisticsAcrossServerTypes(t *testing.T) {
	f := activityReadFixture(t)
	now := time.Now().UTC().Truncate(time.Hour)
	seedWatch(t, f, "a", "m1", "Movie", "Popular Movie", now.Add(-2*time.Hour), 60)
	seedWatch(t, f, "b", "m1", "Movie", "Popular Movie", now.Add(-26*time.Hour), 30)
	seedWatch(t, f, "c", "m2", "movie", "Other Movie", now.Add(-3*time.Hour), 90)
	seedWatch(t, f, "d", "e1", "Episode", "Pilot", now.Add(-4*time.Hour), 45)
	seedWatch(t, f, "d2", "e2", "Episode", "Second", now.Add(-5*time.Hour), 45)
	seedWatch(t, f, "t1", "tr1", "Track", "Song One", now.Add(-6*time.Hour), 3)
	seedWatch(t, f, "t2", "tr2", "track", "Song Two", now.Add(-7*time.Hour), 4)
	seedWatch(t, f, "e", "m3", "Movie", "Too Old", now.AddDate(0, 0, -20), 120)
	activityExec(t, f.store, "UPDATE media_activity_history SET parent_item_id='show1',parent_title='A Show' WHERE item_id IN ('e1','e2')")
	activityExec(t, f.store, "UPDATE media_activity_history SET parent_item_id='album1',parent_title='An Album' WHERE item_id IN ('tr1','tr2')")
	activityExec(t, f.store, "UPDATE media_activity_history SET platform='Roku' WHERE external_session_id IN ('a','b')")
	// Audiobookshelf can't be monitored: its imported listening counts.
	activityExec(t, f.store, `INSERT INTO media_servers(server_nickname,service_type,url) VALUES('Books','audiobookshelf','http://books.invalid'),('Comics','kavita','http://comics.invalid'),('Plex','plex','http://plex.invalid')`)
	var books, plex int64
	_ = f.store.reader.QueryRow("SELECT id FROM media_servers WHERE server_nickname='Books'").Scan(&books)
	_ = f.store.reader.QueryRow("SELECT id FROM media_servers WHERE server_nickname='Plex'").Scan(&plex)
	activityExec(t, f.store, `INSERT INTO history_imports(server_id,entry_key,account_id,viewed_at,media_type,item_id,title,parent_title,imported_at,listened_seconds) VALUES(?,?,?,?,?,?,?,?,?,?)`,
		books, "k1", "reader", utcTimestamp(now.Add(-8*time.Hour)), "book", "b1", "A Book", "An Author", utcTimestamp(now), 1200)
	activityExec(t, f.store, `INSERT INTO history_imports(server_id,entry_key,account_id,viewed_at,media_type,item_id,title,imported_at,listened_seconds) VALUES(?,?,?,?,?,?,?,?,?)`,
		books, "k2", "reader", utcTimestamp(now.AddDate(0, 0, -30)), "book", "b2", "Old Book", utcTimestamp(now), 600)
	activityExec(t, f.store, "INSERT INTO history_import_runs(server_id,state,started_at,finished_at) VALUES(?,'completed',?,?)", books, utcTimestamp(now), utcTimestamp(now))
	// A monitored server's imported history would repeat MUM's recordings: it isn't counted.
	activityExec(t, f.store, `INSERT INTO history_imports(server_id,entry_key,account_id,viewed_at,media_type,item_id,title,imported_at) VALUES(?,?,?,?,?,?,?,?)`,
		plex, "p1", "x", utcTimestamp(now.Add(-time.Hour)), "movie", "pm", "Imported Plex Movie", utcTimestamp(now))

	w := apiRequest(f.app, "GET", "/api/activity/statistics?days=7", f.ownerToken, nil, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var body activityStatsBody
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	var recorded int64
	_ = f.store.reader.QueryRow("SELECT count(*) FROM media_activity_history WHERE first_seen_at>=?", utcTimestamp(time.Now().AddDate(0, 0, -7))).Scan(&recorded)
	d := body.Data
	// The book's reader isn't linked to anyone, so there are two people.
	if d.Days != 7 || d.Totals.Plays != recorded+1 || d.Totals.People != 2 || d.Totals.Seconds < 1200 {
		t.Fatalf("totals %+v (recorded %d)", d.Totals, recorded)
	}
	sections := map[string]int{}
	for i, section := range d.Sections {
		sections[section.Kind] = i
	}
	for _, kind := range []string{"movies", "shows", "music", "audiobooks"} {
		if _, ok := sections[kind]; !ok {
			t.Fatalf("no %s section: %s", kind, w.Body.String())
		}
	}
	movies, shows, music, audiobooks := d.Sections[sections["movies"]], d.Sections[sections["shows"]], d.Sections[sections["music"]], d.Sections[sections["audiobooks"]]
	if movies.Items[0].Title != "Popular Movie" || movies.Items[0].Plays != 2 || movies.Items[0].Seconds != 90*60 || movies.Items[1].Title != "Other Movie" {
		t.Fatalf("movies %+v", movies.Items)
	}
	if shows.Items[0].Title != "A Show" || shows.Items[0].Plays != 2 {
		t.Fatalf("shows %+v", shows)
	}
	if music.Items[0].Title != "An Album" || music.Items[0].Plays != 2 {
		t.Fatalf("music %+v", music)
	}
	if len(audiobooks.Items) != 1 || audiobooks.Items[0].Title != "A Book" || audiobooks.Items[0].Seconds != 1200 ||
		audiobooks.Items[0].Subtitle == nil || *audiobooks.Items[0].Subtitle != "An Author" {
		t.Fatalf("audiobooks %+v", audiobooks)
	}
	if len(d.Platforms) == 0 || d.Platforms[0].Name != "Roku" || d.Platforms[0].Plays != 2 {
		t.Fatalf("platforms %+v", d.Platforms)
	}
	if len(d.Unreported) != 1 || d.Unreported[0].Name != "Comics" || d.Unreported[0].Type != "kavita" {
		t.Fatalf("unreported %+v", d.Unreported)
	}
	if len(d.Imported) != 1 || d.Imported[0].Name != "Books" || d.Imported[0].ImportedAt == nil {
		t.Fatalf("imported %+v", d.Imported)
	}
	// Each title names its server; the picker offers the servers that report.
	if movies.Items[0].Server != f.server || audiobooks.Items[0].Server != books {
		t.Fatalf("title servers %+v %+v", movies.Items[0], audiobooks.Items[0])
	}
	offered := map[string]bool{}
	for _, server := range d.Servers {
		offered[server.Name] = true
	}
	if !offered["Books"] || !offered["Plex"] || offered["Comics"] || len(d.Servers) != 3 {
		t.Fatalf("servers %+v", d.Servers)
	}
	// One server: only its plays, people and titles.
	w1 := apiRequest(f.app, "GET", "/api/activity/statistics?days=7&server="+strconv.FormatInt(books, 10), f.ownerToken, nil, nil)
	var only activityStatsBody
	if err := json.Unmarshal(w1.Body.Bytes(), &only); err != nil || w1.Code != 200 {
		t.Fatal(w1.Code, w1.Body.String())
	}
	if only.Data.Totals.Plays != 1 || only.Data.Totals.People != 1 || len(only.Data.Sections) != 1 || only.Data.Sections[0].Kind != "audiobooks" || len(only.Data.Platforms) != 0 {
		t.Fatalf("one server %+v", only.Data)
	}
	var comics int64
	_ = f.store.reader.QueryRow("SELECT id FROM media_servers WHERE server_nickname='Comics'").Scan(&comics)
	for _, bad := range []string{"0", "999999", "x", strconv.FormatInt(comics, 10)} {
		if w := apiRequest(f.app, "GET", "/api/activity/statistics?server="+bad, f.ownerToken, nil, nil); w.Code != 400 && w.Code != 404 {
			t.Fatal("accepted server", bad, w.Code)
		}
	}
	for _, hidden := range []string{"Too Old", "Old Book", "Imported Plex Movie"} {
		if strings.Contains(w.Body.String(), hidden) {
			t.Fatal("counted", hidden)
		}
	}
	for _, bad := range []string{"?days=0", "?days=91", "?days=x", "?other=1"} {
		if w := apiRequest(f.app, "GET", "/api/activity/statistics"+bad, f.ownerToken, nil, nil); w.Code != 400 {
			t.Fatal(bad, w.Code)
		}
	}
	activityExec(t, f.store, "DELETE FROM admin_privileges WHERE user_uuid=?", f.user)
	if w := apiRequest(f.app, "GET", "/api/activity/statistics", f.token, nil, nil); w.Code != 403 {
		t.Fatal("non-administrator read statistics", w.Code)
	}
}
