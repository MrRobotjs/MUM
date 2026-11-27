package main

import (
	"database/sql"
	"encoding/json"
	"strconv"
	"strings"
	"testing"
	"time"
)

// A play's poster: the title's catalogue poster first (the movie, or an
// episode's show), else the poster stored with the play (MUM's or imported),
// else none. A stored poster without its source item can only come from the
// image cache.
func TestPlayPosterURL(t *testing.T) {
	f := activityReadFixture(t)
	activityExec(t, f.store, "INSERT INTO media_libraries(server_id,external_id,name,library_type) VALUES(?,'lib','Video','movie')", f.server)
	var library int64
	_ = f.store.reader.QueryRow("SELECT id FROM media_libraries WHERE external_id='lib'").Scan(&library)
	activityExec(t, f.store, `INSERT INTO media_items(library_id,server_id,external_id,title,item_type,thumb_path) VALUES
	 (?,?,'movie','A Movie','movie','/library/metadata/1/thumb/1'),(?,?,'bare','No Poster','movie',NULL),(?,?,'show','A Show','show','/library/metadata/2/thumb/2')`,
		library, f.server, library, f.server, library, f.server)
	activityExec(t, f.store, "INSERT INTO media_items(library_id,server_id,external_id,parent_id,title,item_type) VALUES(?,?,'ep','show','Pilot','episode')", library, f.server)
	ids := map[string]int64{}
	for _, external := range []string{"movie", "bare", "show"} {
		var id int64
		_ = f.store.reader.QueryRow("SELECT id FROM media_items WHERE external_id=?", external).Scan(&id)
		ids[external] = id
	}
	tx, err := f.store.reader.BeginTx(t.Context(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	now := time.Now()
	cases := []struct {
		name   string
		poster playPoster
		want   string
	}{
		{"catalogued movie, nothing stored", playPoster{server: f.server, item: "movie"}, "/api/media/images/" + strconv.FormatInt(ids["movie"], 10) + "?"},
		{"catalogued movie wins over a stored poster", playPoster{server: f.server, item: "movie", row: 9, stored: true}, "/api/media/images/" + strconv.FormatInt(ids["movie"], 10) + "?"},
		{"episode: its show's poster", playPoster{server: f.server, item: "ep", parent: "show"}, "/api/media/images/" + strconv.FormatInt(ids["show"], 10) + "?"},
		{"catalogued without a poster: the stored one", playPoster{server: f.server, item: "bare", art: "bare", row: 7, stored: true}, "/api/activity/history-images/7?"},
		{"not catalogued: the stored imported one", playPoster{server: f.server, item: "elsewhere", art: "elsewhere", row: 5, imported: true, stored: true}, "/api/activity/imported-history-images/5?"},
		{"stored without its source item and not cached: none", playPoster{server: f.server, item: "elsewhere", row: 5, imported: true, stored: true}, ""},
		{"nothing at all", playPoster{server: f.server, item: "elsewhere"}, ""},
	}
	for _, c := range cases {
		got, err := f.app.playPosterURL(t.Context(), tx, "session", c.poster, now)
		if err != nil {
			t.Fatal(c.name, err)
		}
		if c.want == "" && got != "" || c.want != "" && !strings.HasPrefix(got, c.want) {
			t.Fatalf("%s: %q, want %q…", c.name, got, c.want)
		}
	}
}

// The dashboard's Activity cards show a catalogued title's poster even when
// none of its plays kept one (plays recorded before posters were stored).
func TestActivityStatisticsCataloguePoster(t *testing.T) {
	f := activityReadFixture(t)
	activityExec(t, f.store, "DELETE FROM media_activity_current")
	activityExec(t, f.store, "DELETE FROM media_activity_history")
	seedWatch(t, f, "a", "92931", "Movie", "Scream 7", time.Now().UTC().Add(-2*time.Hour), 60)
	activityExec(t, f.store, "INSERT INTO media_libraries(server_id,external_id,name,library_type) VALUES(?,'lib','Movies','movie')", f.server)
	var library, item int64
	_ = f.store.reader.QueryRow("SELECT id FROM media_libraries WHERE external_id='lib'").Scan(&library)
	activityExec(t, f.store, "INSERT INTO media_items(library_id,server_id,external_id,title,item_type,thumb_path) VALUES(?,?,'92931','Scream 7','movie','/library/metadata/92931/thumb/1790151391')", library, f.server)
	_ = f.store.reader.QueryRow("SELECT id FROM media_items WHERE external_id='92931'").Scan(&item)
	w := apiRequest(f.app, "GET", "/api/activity/statistics?days=7", f.ownerToken, nil, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var body struct {
		Data struct {
			Sections []struct {
				Kind  string `json:"kind"`
				Items []struct {
					Title  string  `json:"title"`
					Poster *string `json:"poster_url"`
				} `json:"items"`
			} `json:"sections"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, section := range body.Data.Sections {
		if section.Kind != "movies" {
			continue
		}
		for _, it := range section.Items {
			if it.Title == "Scream 7" {
				found = it.Poster != nil && strings.HasPrefix(*it.Poster, "/api/media/images/"+strconv.FormatInt(item, 10)+"?")
			}
		}
	}
	if !found {
		t.Fatal("no catalogue poster for a title whose plays kept none", w.Body.String())
	}
}
