package main

import (
	"encoding/json"
	"fmt"
	"net/url"
	"testing"
)

type serverLibraryRow struct {
	ID           int64   `json:"id"`
	Name         string  `json:"name"`
	Type         *string `json:"library_type"`
	Items        *int    `json:"item_count"`
	Parents      *int    `json:"parent_count"`
	Children     *int    `json:"child_count"`
	Plays        int     `json:"plays"`
	Watch        *int64  `json:"watch_seconds"`
	LastStreamed *string `json:"last_streamed_at"`
	LastPlayed   *struct {
		Title  string `json:"title"`
		Source string `json:"source"`
		Link   *struct {
			Library int64 `json:"library_id"`
			Media   int64 `json:"media_id"`
		} `json:"link"`
	} `json:"last_played"`
}

// serverLibrariesFixture adds Plex++ libraries to the accounts fixture: plays
// reach a library through the catalogue (MUM one, via its show), by library
// name (MUM three), or by the imported library id; a name two libraries share
// matches neither, and another server's import never counts.
func serverLibrariesFixture(t *testing.T) (*App, string, int64, map[string]int64) {
	t.Helper()
	a, s, token, server := serverAccountsFixture(t)
	ids := map[string]int64{}
	for _, l := range []struct{ external, name, kind string }{{"1", "Movies", "movie"}, {"2", "TV Shows", "show"}, {"3", "Music", "artist"}, {"4", "Dup", "movie"}, {"5", "Dup", "movie"}} {
		activityExec(t, s, "INSERT INTO media_libraries(server_id,external_id,name,library_type,item_count) VALUES(?,?,?,?,10)", server, l.external, l.name, l.kind)
		var id int64
		_ = s.reader.QueryRow("SELECT id FROM media_libraries WHERE server_id=? AND external_id=?", server, l.external).Scan(&id)
		ids[l.external] = id
	}
	activityExec(t, s, "INSERT INTO media_items(library_id,server_id,external_id,title,item_type) VALUES(?,?,'show1','A Show','show')", ids["2"], server)
	activityExec(t, s, "UPDATE media_activity_history SET parent_item_id='show1',parent_title='A Show' WHERE title='MUM one'")
	activityExec(t, s, "UPDATE media_activity_history SET library_name='Movies' WHERE title='MUM three'")
	activityExec(t, s, `INSERT INTO media_activity_history(server_id,external_session_id,service_uuid,owner_uuid,item_id,media_type,title,first_seen_at,last_seen_at,paused,client,library_name)
	 SELECT server_id,'dup-session',service_uuid,owner_uuid,'dup-item','movie','Duplicate name','2026-11-01T05:00:00.000000000Z','2026-11-01T05:05:00.000000000Z',0,'Plex Web','Dup' FROM media_activity_history WHERE title='MUM one'`)
	activityExec(t, s, "UPDATE history_imports SET library_id='2' WHERE entry_key='/h/2' AND server_id=?", server)
	activityExec(t, s, "UPDATE history_imports SET library_id='1' WHERE entry_key='/h/4' AND server_id=?", server)
	activityExec(t, s, "UPDATE history_imports SET library_id='3' WHERE entry_key='/h/9' AND server_id=?", server)
	activityExec(t, s, "UPDATE history_imports SET library_id='1' WHERE entry_key='/o/1'")
	// The TV catalogue is synced: one show, three episodes over two seasons. The
	// music catalogue is synced: one album with two tracks. Movies isn't synced.
	for _, e := range []struct {
		external string
		season   int
	}{{"e1", 1}, {"e2", 1}, {"e3", 2}} {
		activityExec(t, s, "INSERT INTO media_items(library_id,server_id,external_id,parent_id,title,item_type,season_number) VALUES(?,?,?,'show1','Episode','episode',?)", ids["2"], server, e.external, e.season)
	}
	activityExec(t, s, "INSERT INTO media_items(library_id,server_id,external_id,title,item_type) VALUES(?,?,'album1','An Album','album')", ids["3"], server)
	activityExec(t, s, "INSERT INTO media_items(library_id,server_id,external_id,parent_id,title,item_type) VALUES(?,?,'t1','album1','One','track'),(?,?,'t2','album1','Two','track')", ids["3"], server, ids["3"], server)
	activityExec(t, s, "UPDATE media_libraries SET catalogue_synced_at='2026-11-01T00:00:00.000000000Z' WHERE id IN (?,?)", ids["2"], ids["3"])
	activityExec(t, s, "UPDATE media_libraries SET item_count=NULL,catalogue_item_count=7 WHERE id=?", ids["2"])
	activityExec(t, s, "UPDATE media_libraries SET item_count=NULL WHERE id IN (?,?)", ids["4"], ids["5"])
	return a, token, server, ids
}

func readServerLibraries(t *testing.T, a *App, token string, server int64, query url.Values) (int, map[string]serverLibraryRow, string) {
	t.Helper()
	w := apiRequest(a, "GET", fmt.Sprintf("/api/servers/%d/library-activity?%s", server, query.Encode()), token, nil, nil)
	var out struct {
		Data struct {
			ServerID int64              `json:"server_id"`
			Records  string             `json:"records"`
			Items    []serverLibraryRow `json:"items"`
		}
	}
	rows := map[string]serverLibraryRow{}
	if w.Code == 200 {
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		for _, row := range out.Data.Items {
			key := row.Name
			if _, dup := rows[key]; dup {
				key += "#2"
			}
			rows[key] = row
		}
	}
	return w.Code, rows, out.Data.Records
}

func TestServerLibraryActivityOnThisServer(t *testing.T) {
	a, token, server, ids := serverLibrariesFixture(t)
	code, rows, records := readServerLibraries(t, a, token, server, url.Values{})
	if code != 200 || records != "all" || len(rows) != 5 {
		t.Fatalf("libraries %d %s %+v", code, records, rows)
	}
	movies, tv, music := rows["Movies"], rows["TV Shows"], rows["Music"]
	// Movies: MUM three (by name) and the imported /h/4, never the other server's import.
	if movies.Plays != 2 || movies.LastStreamed == nil || *movies.LastStreamed != "2026-11-01T04:00:00.000000000Z" ||
		movies.LastPlayed == nil || movies.LastPlayed.Title != "Plex four" || movies.Watch == nil || *movies.Watch != 10*60 || movies.Items == nil || *movies.Items != 10 {
		t.Fatalf("movies %+v", movies)
	}
	// TV: MUM one (through its show in the catalogue) and the imported /h/2; its last play opens the show.
	if tv.Plays != 2 || tv.LastPlayed == nil || tv.LastPlayed.Title != "Plex two" || tv.Watch == nil || *tv.Watch != 30*60 {
		t.Fatalf("tv %+v", tv)
	}
	if music.Plays != 1 || music.Watch == nil || *music.Watch != 0 {
		t.Fatalf("music %+v", music)
	}
	// Seasons and episodes, albums and tracks, from synced catalogues only.
	if tv.Parents == nil || *tv.Parents != 2 || tv.Children == nil || *tv.Children != 3 {
		t.Fatalf("tv counts %v %v", tv.Parents, tv.Children)
	}
	if music.Parents == nil || *music.Parents != 1 || music.Children == nil || *music.Children != 2 {
		t.Fatalf("music counts %v %v", music.Parents, music.Children)
	}
	if movies.Parents != nil || movies.Children != nil {
		t.Fatalf("movies counts %v %v", movies.Parents, movies.Children)
	}
	// A server that doesn't report a library's size (Plex): the synced
	// catalogue's count, otherwise nothing rather than 0.
	if rows["Dup"].Items != nil || tv.Items == nil || *tv.Items != 7 {
		t.Fatalf("items fallback %v %v", rows["Dup"].Items, tv.Items)
	}
	// A name two libraries share counts for neither.
	if rows["Dup"].Plays != 0 || rows["Dup#2"].Plays != 0 || rows["Dup"].LastStreamed != nil {
		t.Fatalf("dup %+v %+v", rows["Dup"], rows["Dup#2"])
	}

	_, mum, _ := readServerLibraries(t, a, token, server, url.Values{"records": {"mum"}})
	if mum["Movies"].Plays != 1 || mum["TV Shows"].Plays != 1 || mum["Music"].Plays != 0 || mum["TV Shows"].LastPlayed == nil ||
		mum["TV Shows"].LastPlayed.Source != "mum" || mum["TV Shows"].LastPlayed.Link == nil || mum["TV Shows"].LastPlayed.Link.Library != ids["2"] {
		t.Fatalf("mum %+v", mum)
	}
	_, imported, _ := readServerLibraries(t, a, token, server, url.Values{"records": {"server"}})
	if imported["Movies"].Plays != 1 || imported["Music"].Plays != 1 || imported["Movies"].Watch != nil {
		t.Fatalf("server %+v", imported)
	}
}

func TestServerLibraryActivityAccess(t *testing.T) {
	a, token, server, _ := serverLibrariesFixture(t)
	for _, bad := range []url.Values{{"records": {"both"}}, {"extra": {"1"}}, {"records": {"all", "mum"}}} {
		if code, _, _ := readServerLibraries(t, a, token, server, bad); code != 400 {
			t.Fatal("accepted", bad, code)
		}
	}
	if code, _, _ := readServerLibraries(t, a, token, 9999, url.Values{}); code != 404 {
		t.Fatal("unknown server", code)
	}
	w := apiRequest(a, "POST", "/api/auth/login", "", map[string]any{"username": "viewer", "password": "a-strong-member-password"}, nil)
	if code, _, _ := readServerLibraries(t, a, responseData(t, w)["access_token"].(string), server, url.Values{}); code != 403 {
		t.Fatal("a member read the server's libraries", code)
	}
}
