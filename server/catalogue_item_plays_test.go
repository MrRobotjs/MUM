package main

import (
	"database/sql"
	"strconv"
	"testing"
	"time"
)

// An item's play summary counts MUM's recordings and imported history, people
// once across both, watch time from recordings only, and the newest play.
func TestCatalogueItemPlays(t *testing.T) {
	f := activityReadFixture(t)
	activityExec(t, f.store, "DELETE FROM media_activity_current")
	activityExec(t, f.store, "DELETE FROM media_activity_history")
	activityExec(t, f.store, "INSERT INTO media_libraries(server_id,external_id,name,library_type) VALUES(?,'lib','Mixed','movie')", f.server)
	var library int64
	_ = f.store.reader.QueryRow("SELECT id FROM media_libraries WHERE external_id='lib'").Scan(&library)
	activityExec(t, f.store, `INSERT INTO media_items(library_id,server_id,external_id,title,item_type) VALUES(?,?,'mv','A Movie','movie'),(?,?,'sh','A Show','show'),(?,?,'quiet','Unplayed','movie')`,
		library, f.server, library, f.server, library, f.server)
	activityExec(t, f.store, `INSERT INTO media_items(library_id,server_id,external_id,parent_id,title,item_type) VALUES(?,?,'e1','sh','Pilot','episode'),(?,?,'e2','sh','Second','episode')`,
		library, f.server, library, f.server)
	var account string
	_ = f.store.reader.QueryRow("SELECT external_user_id FROM service_accounts WHERE uuid=?", f.service).Scan(&account)

	now := time.Now().UTC().Truncate(time.Second)
	seedWatch(t, f, "m1", "mv", "Movie", "A Movie", now.Add(-5*time.Hour), 60)
	seedWatch(t, f, "m2", "mv", "Movie", "A Movie", now.Add(-4*time.Hour), 30)
	seedWatch(t, f, "s1", "e1", "Episode", "Pilot", now.Add(-3*time.Hour), 20)
	activityExec(t, f.store, "UPDATE media_activity_history SET parent_item_id='sh' WHERE external_session_id='s1'")
	imported := func(key, who, item, title string, at time.Time) {
		activityExec(t, f.store, `INSERT INTO history_imports(server_id,entry_key,account_id,viewed_at,media_type,item_id,title,imported_at) VALUES(?,?,?,?,'movie',?,?,?)`,
			f.server, key, who, utcTimestamp(at), item, title, utcTimestamp(now))
	}
	imported("i1", account, "mv", "A Movie", now.Add(-48*time.Hour)) // the same person as MUM's plays
	imported("i2", "stranger", "mv", "A Movie (imported)", now.Add(-time.Hour))
	imported("i3", account, "e2", "Second", now.Add(-2*time.Hour))

	tx, err := f.store.reader.BeginTx(t.Context(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	read := func(external string, episode bool) catalogueItemPlays {
		t.Helper()
		p, err := readCatalogueItemPlays(t.Context(), tx, f.server, library, external, episode)
		if err != nil {
			t.Fatal(external, err)
		}
		return p
	}
	movie := read("mv", false)
	if movie.Plays != 4 || movie.Recorded != 2 || movie.Imported != 2 || movie.WatchSeconds != 90*60 || movie.Viewers != 1 {
		t.Fatalf("movie %+v", movie)
	}
	if movie.LastPlayedAt == nil || *movie.LastPlayedAt != utcTimestamp(now.Add(-time.Hour)) || movie.LastTitle == nil || *movie.LastTitle != "A Movie (imported)" || movie.LastViewer != nil {
		t.Fatalf("movie last play %+v", movie)
	}
	show := read("sh", false)
	if show.Plays != 2 || show.Recorded != 1 || show.Imported != 1 || show.WatchSeconds != 20*60 || show.Viewers != 1 || *show.LastTitle != "Second" || show.LastViewer == nil {
		t.Fatalf("show %+v", show)
	}
	if e1, e2 := read("e1", true), read("e2", true); e1.Plays != 1 || e1.Recorded != 1 || e2.Plays != 1 || e2.Imported != 1 || e2.WatchSeconds != 0 {
		t.Fatalf("episodes %+v %+v", e1, e2)
	}
	if quiet := read("quiet", false); quiet.Plays != 0 || quiet.LastPlayedAt != nil || quiet.Viewers != 0 {
		t.Fatalf("unplayed %+v", quiet)
	}
	_ = tx.Rollback()

	// The item read carries the summary.
	var movieID int64
	_ = f.store.reader.QueryRow("SELECT id FROM media_items WHERE external_id='mv'").Scan(&movieID)
	w := apiRequest(f.app, "GET", "/api/libraries/"+strconv.FormatInt(library, 10)+"/media/"+strconv.FormatInt(movieID, 10), f.ownerToken, nil, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	plays, _ := responseData(t, w)["plays"].(map[string]any)
	if plays == nil || plays["plays"] != float64(4) || plays["viewers"] != float64(1) {
		t.Fatal(w.Body.String())
	}
}
