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
				People   int64   `json:"people"`
				PlayedAt *string `json:"played_at"`
				UserUUID *string `json:"user_uuid"`
				Library  *int64  `json:"library_id"`
				Avatar   *string `json:"avatar_url"`
				UserName *string `json:"user_name"`
				Servers  []int64 `json:"server_ids"`
				Link     *struct {
					Library int64  `json:"library_id"`
					Media   int64  `json:"media_id"`
					Episode *int64 `json:"episode_id"`
				} `json:"link"`
			} `json:"items"`
		} `json:"sections"`
		Concurrent []struct {
			Kind    string `json:"kind"`
			Count   int    `json:"count"`
			Started string `json:"started"`
		} `json:"concurrent"`
		Platforms []struct {
			Name    string  `json:"name"`
			Plays   int64   `json:"plays"`
			Servers []int64 `json:"server_ids"`
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
	// Plays a (2h ago, an hour long) and c (3h ago, 90 minutes) overlap.
	activityExec(t, f.store, "UPDATE media_activity_history SET play_method='transcode' WHERE external_session_id IN ('a','d')")
	activityExec(t, f.store, "UPDATE media_activity_history SET play_method='direct_play' WHERE external_session_id='c'")
	activityExec(t, f.store, "UPDATE service_accounts SET external_user_id='0123456789abcdef0123456789abcdef' WHERE uuid=?", f.service)
	// The catalogue holds the popular movie and the show with its pilot, so
	// their rows open their pages; the other titles haven't been synced.
	activityExec(t, f.store, "INSERT INTO media_libraries(server_id,external_id,name,library_type) VALUES(?,'lib-v','Video','movie')", f.server)
	var video int64
	_ = f.store.reader.QueryRow("SELECT id FROM media_libraries WHERE external_id='lib-v'").Scan(&video)
	activityExec(t, f.store, "INSERT INTO media_items(library_id,server_id,external_id,title,item_type) VALUES(?,?,'m1','Popular Movie','movie'),(?,?,'show1','A Show','show')", video, f.server, video, f.server)
	activityExec(t, f.store, "INSERT INTO media_items(library_id,server_id,external_id,parent_id,title,item_type) VALUES(?,?,'e1','show1','Pilot','episode')", video, f.server)
	var movieItem, showItem, pilotItem int64
	_ = f.store.reader.QueryRow("SELECT id FROM media_items WHERE external_id='m1'").Scan(&movieItem)
	_ = f.store.reader.QueryRow("SELECT id FROM media_items WHERE external_id='show1'").Scan(&showItem)
	_ = f.store.reader.QueryRow("SELECT id FROM media_items WHERE external_id='e1'").Scan(&pilotItem)
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
	activityExec(t, f.store, "INSERT INTO media_libraries(server_id,external_id,name,library_type) VALUES(?,'lib-books','Audiobooks','book')", books)
	activityExec(t, f.store, "UPDATE history_imports SET library_id='lib-books' WHERE server_id=?", books)
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
	// Most popular by people, recently played, most
	// active users and libraries.
	for _, kind := range []string{"popular_movies", "popular_shows", "popular_music", "recent", "users", "libraries"} {
		if _, ok := sections[kind]; !ok {
			t.Fatalf("no %s section: %s", kind, w.Body.String())
		}
	}
	popular := d.Sections[sections["popular_movies"]].Items[0]
	if popular.People != 1 || (popular.Title != "Popular Movie" && popular.Title != "Other Movie") {
		t.Fatalf("popular %+v", popular)
	}
	recent := d.Sections[sections["recent"]].Items
	if len(recent) == 0 || recent[0].PlayedAt == nil || len(recent) > 10 {
		t.Fatalf("recent %+v", recent)
	}
	users := d.Sections[sections["users"]].Items
	if len(users) != 2 || users[0].UserUUID == nil || *users[0].UserUUID != f.user || users[0].Plays != recorded {
		t.Fatalf("users %+v", users)
	}
	// The person's picture comes from their linked Jellyfin account; the
	// unlinked reader has none.
	if users[0].Avatar == nil || !strings.HasPrefix(*users[0].Avatar, "/api/service-avatars/") || users[1].Avatar != nil {
		t.Fatalf("user pictures %+v %+v", users[0].Avatar, users[1].Avatar)
	}
	libraries := d.Sections[sections["libraries"]].Items
	if len(libraries) != 2 || libraries[0].Library == nil {
		t.Fatalf("libraries %+v", libraries)
	}
	// Catalogued titles link to their pages: the movie, the show, and in
	// Recently played the pilot's episode page. Others don't.
	if l := movies.Items[0].Link; l == nil || l.Library != video || l.Media != movieItem || l.Episode != nil || movies.Items[1].Link != nil {
		t.Fatalf("movie links %+v %+v", movies.Items[0].Link, movies.Items[1].Link)
	}
	if l := shows.Items[0].Link; l == nil || l.Media != showItem || l.Episode != nil {
		t.Fatalf("show link %+v", l)
	}
	pilot := false
	for _, item := range recent {
		// Recently played names who played each title.
		if item.UserName == nil || *item.UserName == "" {
			t.Fatalf("recent without a name %+v", item)
		}
		if item.Subtitle != nil && *item.Subtitle == "Pilot" {
			pilot = item.Link != nil && item.Link.Media == showItem && item.Link.Episode != nil && *item.Link.Episode == pilotItem
		}
	}
	if !pilot || *recent[0].UserName != users[0].Title {
		t.Fatalf("recent links and names %+v", recent)
	}
	// People and platforms name the servers they used, for their badges.
	if len(users[0].Servers) != 1 || users[0].Servers[0] != f.server || len(users[1].Servers) != 1 || users[1].Servers[0] != books ||
		len(d.Platforms[0].Servers) != 1 || d.Platforms[0].Servers[0] != f.server {
		t.Fatalf("servers used %+v %+v %+v", users[0].Servers, users[1].Servers, d.Platforms[0].Servers)
	}
	// Play duration ranks by time instead of plays.
	wd := apiRequest(f.app, "GET", "/api/activity/statistics?days=7&order=duration", f.ownerToken, nil, nil)
	var byTime activityStatsBody
	if err := json.Unmarshal(wd.Body.Bytes(), &byTime); err != nil || wd.Code != 200 {
		t.Fatal(wd.Code, wd.Body.String())
	}
	for _, section := range byTime.Data.Sections {
		if section.Kind == "users" && section.Items[0].Seconds < section.Items[len(section.Items)-1].Seconds {
			t.Fatalf("duration order %+v", section.Items)
		}
	}
	// Most concurrent streams: a and c at once; one transcode and one direct
	// play at a time; no direct streams, so no row for them.
	peaks := map[string]int{}
	for _, peak := range d.Concurrent {
		peaks[peak.Kind] = peak.Count
	}
	if len(d.Concurrent) != 3 || d.Concurrent[0].Kind != "all" || peaks["all"] != 2 || peaks["transcode"] != 1 || peaks["direct_play"] != 1 ||
		d.Concurrent[0].Started != utcTimestamp(now.Add(-2*time.Hour)) {
		t.Fatalf("concurrent %+v", d.Concurrent)
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
	kinds := []string{}
	for _, section := range only.Data.Sections {
		kinds = append(kinds, section.Kind)
	}
	if only.Data.Totals.Plays != 1 || only.Data.Totals.People != 1 || len(only.Data.Platforms) != 0 || strings.Join(kinds, ",") != "audiobooks,recent,users,libraries" {
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
	// A custom period: the last 25 days take in the 20-day-old play but not the 30-day-old book.
	wc := apiRequest(f.app, "GET", "/api/activity/statistics?days=25", f.ownerToken, nil, nil)
	if wc.Code != 200 || !strings.Contains(wc.Body.String(), "Too Old") || strings.Contains(wc.Body.String(), "Old Book") {
		t.Fatal("custom period", wc.Code, wc.Body.String())
	}
	// All time takes in the older plays too.
	wa := apiRequest(f.app, "GET", "/api/activity/statistics?days=0", f.ownerToken, nil, nil)
	var all activityStatsBody
	if err := json.Unmarshal(wa.Body.Bytes(), &all); err != nil || wa.Code != 200 {
		t.Fatal(wa.Code, wa.Body.String())
	}
	if all.Data.Days != 0 || all.Data.Totals.Plays != d.Totals.Plays+2 || !strings.Contains(wa.Body.String(), "Too Old") || !strings.Contains(wa.Body.String(), "Old Book") {
		t.Fatalf("all time %+v", all.Data.Totals)
	}
	// Imported history (off by default): a monitored server's imported plays
	// from before MUM first recorded on it count; later ones would repeat
	// MUM's recordings and don't. The Plex server has no recordings, so all of
	// its imported plays count.
	jellyfinAccount := "0123456789abcdef0123456789abcdef"
	activityExec(t, f.store, `INSERT INTO history_imports(server_id,entry_key,account_id,viewed_at,media_type,item_id,title,poster_item,poster_path,imported_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
		f.server, "j1", jellyfinAccount, utcTimestamp(now.AddDate(0, 0, -25)), "movie", "m9", "Backfilled Movie", "m9", "Primary/tag", utcTimestamp(now))
	activityExec(t, f.store, `INSERT INTO history_imports(server_id,entry_key,account_id,viewed_at,media_type,item_id,title,parent_title,grandparent_title,imported_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
		f.server, "j2", jellyfinAccount, utcTimestamp(now.AddDate(0, 0, -24)), "episode", "e0", "Prologue", "Season 1", "A Show", utcTimestamp(now))
	activityExec(t, f.store, `INSERT INTO history_imports(server_id,entry_key,account_id,viewed_at,media_type,item_id,title,imported_at) VALUES(?,?,?,?,?,?,?,?)`,
		f.server, "j3", jellyfinAccount, utcTimestamp(now.Add(-time.Hour)), "movie", "m1", "Overlap Movie", utcTimestamp(now))
	if again := apiRequest(f.app, "GET", "/api/activity/statistics?days=0", f.ownerToken, nil, nil); strings.Contains(again.Body.String(), "Backfilled") {
		t.Fatal("imported history counted without asking")
	}
	wi := apiRequest(f.app, "GET", "/api/activity/statistics?days=0&imported=1", f.ownerToken, nil, nil)
	var with activityStatsBody
	if err := json.Unmarshal(wi.Body.Bytes(), &with); err != nil || wi.Code != 200 {
		t.Fatal(wi.Code, wi.Body.String())
	}
	withBody := wi.Body.String()
	// Backfilled Movie, the prologue and the Plex server's movie; not the overlap.
	if with.Data.Totals.Plays != all.Data.Totals.Plays+3 || !strings.Contains(withBody, "Backfilled Movie") || !strings.Contains(withBody, "Imported Plex Movie") ||
		strings.Contains(withBody, "Overlap Movie") || !strings.Contains(withBody, `"with_imported":true`) {
		t.Fatalf("with imported history %+v", with.Data.Totals)
	}
	// Imported plays have no length, and the same person is still one person.
	if with.Data.Totals.Seconds != all.Data.Totals.Seconds || with.Data.Totals.People != all.Data.Totals.People+1 {
		t.Fatalf("imported time and people %+v vs %+v", with.Data.Totals, all.Data.Totals)
	}
	for _, section := range with.Data.Sections {
		for _, item := range section.Items {
			// The imported prologue joins A Show's recorded episodes.
			if section.Kind == "shows" && item.Title == "A Show" && item.Plays != 3 {
				t.Fatalf("show with an imported episode %+v", item)
			}
		}
	}
	if !strings.Contains(withBody, "/api/activity/imported-history-images/") {
		t.Fatal("imported poster not signed as imported", withBody)
	}
	for _, bad := range []string{"?days=-1", "?days=3651", "?days=x", "?other=1", "?order=users", "?imported=yes", "?imported=1&imported=1"} {
		if w := apiRequest(f.app, "GET", "/api/activity/statistics"+bad, f.ownerToken, nil, nil); w.Code != 400 {
			t.Fatal(bad, w.Code)
		}
	}
	activityExec(t, f.store, "DELETE FROM admin_privileges WHERE user_uuid=?", f.user)
	if w := apiRequest(f.app, "GET", "/api/activity/statistics", f.token, nil, nil); w.Code != 403 {
		t.Fatal("non-administrator read statistics", w.Code)
	}
}
