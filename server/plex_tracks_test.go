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

const plexAlbumTracks = `<MediaContainer size="3" totalSize="3" offset="0" librarySectionID="9">` +
	`<Track ratingKey="701" type="track" title="Intro" parentRatingKey="77" parentIndex="1" index="1" duration="61000" librarySectionID="9" thumb="/library/metadata/77/thumb/1"/>` +
	`<Track ratingKey="702" type="track" title="Single" parentRatingKey="77" parentIndex="1" index="2" duration="215000" librarySectionID="9" primaryExtraKey="/library/metadata/900"/>` +
	`<Track ratingKey="703" type="track" title="Bonus" parentRatingKey="77" parentIndex="2" index="1" duration="190000" librarySectionID="9"/>` +
	`</MediaContainer>`

func TestPlexTrackAdapterListsTracksAndTheirVideos(t *testing.T) {
	p := plexCatalogueFixture(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/proxy/library/metadata/77/children":
			fmt.Fprint(w, plexAlbumTracks)
		case "/proxy/library/metadata/900":
			fmt.Fprint(w, `<MediaContainer size="1"><Video ratingKey="900" type="clip" title="Single (Official Video)" duration="230000" thumb="/library/metadata/900/thumb/3"/></MediaContainer>`)
		default:
			t.Error("unexpected path", r.URL.Path)
		}
	})
	items, err := p.catalogueChildren(t.Context(), trackChildren, "77")
	if err != nil || len(items) != 4 {
		t.Fatal(items, err)
	}
	got := []string{}
	for _, item := range items {
		got = append(got, fmt.Sprintf("%s:%s:%d.%d", item.ID, item.Type, *item.Season, *item.Episode))
	}
	if strings.Join(got, " ") != "701:track:1.1 702:track:1.2 703:track:2.1 900:music_video:1.2" {
		t.Fatal(got)
	}
	if items[0].ImageTag != "" || items[3].ImageTag != "/library/metadata/900/thumb/3" || *items[3].DurationMS != 230000 {
		t.Fatal("thumbnail or duration", items[0].ImageTag, items[3])
	}
}

func TestPlexTrackAdapterRefusesIncompleteAlbums(t *testing.T) {
	video := `<MediaContainer size="1"><Video ratingKey="900" type="clip" title="Video"/></MediaContainer>`
	for name, tc := range map[string][2]string{
		"another album":     {strings.Replace(plexAlbumTracks, `ratingKey="703" type="track" title="Bonus" parentRatingKey="77"`, `ratingKey="703" type="track" title="Bonus" parentRatingKey="78"`, 1), video},
		"not a track":       {strings.Replace(plexAlbumTracks, `<Track ratingKey="701" type="track"`, `<Track ratingKey="701" type="episode"`, 1), video},
		"missing video":     {plexAlbumTracks, `<MediaContainer size="0"/>`},
		"video not a clip":  {plexAlbumTracks, `<MediaContainer size="1"><Video ratingKey="900" type="movie" title="Video"/></MediaContainer>`},
		"unrequested video": {plexAlbumTracks, `<MediaContainer size="1"><Video ratingKey="901" type="clip" title="Video"/></MediaContainer>`},
		"bad video link":    {strings.Replace(plexAlbumTracks, `primaryExtraKey="/library/metadata/900"`, `primaryExtraKey="https://example.invalid/900"`, 1), video},
	} {
		t.Run(name, func(t *testing.T) {
			p := plexCatalogueFixture(t, func(w http.ResponseWriter, r *http.Request) {
				if strings.HasSuffix(r.URL.Path, "/children") {
					fmt.Fprint(w, tc[0])
				} else {
					fmt.Fprint(w, tc[1])
				}
			})
			if items, err := p.catalogueChildren(t.Context(), trackChildren, "77"); err == nil || items != nil {
				t.Fatal("incomplete album accepted", items, err)
			}
		})
	}
}

func TestPlexMusicLibraryTracksSyncWithTheLibrary(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/proxy/":
			fmt.Fprint(w, `<MediaContainer friendlyName="Plex Fixture" version="1" machineIdentifier="fixture-machine"/>`)
		case "/proxy/library/sections":
			fmt.Fprint(w, `<MediaContainer><Directory key="9" title="Music" type="artist"/><Directory key="8" title="Shows" type="show"/></MediaContainer>`)
		case "/proxy/library/sections/9/all":
			fmt.Fprint(w, `<MediaContainer offset="0" size="1" totalSize="1" librarySectionID="9"><Directory ratingKey="77" type="album" title="Fixture Album" thumb="/library/metadata/77/thumb/1"/></MediaContainer>`)
		case "/proxy/library/sections/8/all":
			fmt.Fprint(w, `<MediaContainer offset="0" size="1" totalSize="1" librarySectionID="8"><Directory ratingKey="55" type="show" title="Fixture Show"/></MediaContainer>`)
		case "/proxy/library/sections/9/collections", "/proxy/library/sections/8/collections":
			fmt.Fprint(w, `<MediaContainer offset="0" size="0" totalSize="0"/>`)
		case "/proxy/library/metadata/77/children":
			fmt.Fprint(w, plexAlbumTracks)
		case "/proxy/library/metadata/900":
			fmt.Fprint(w, `<MediaContainer size="1"><Video ratingKey="900" type="clip" title="Single (Official Video)" duration="230000"/></MediaContainer>`)
		default:
			t.Error("unexpected Plex fixture path", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(upstream.Close)
	server := createManagedServer(t, a, token, "plex", upstream.URL+"/proxy")
	if w := apiRequest(a, "POST", fmt.Sprintf("/api/servers/%d/sync-libraries", server), token, nil, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var music, shows int64
	s.reader.QueryRow("SELECT id FROM media_libraries WHERE server_id=? AND external_id='9'", server).Scan(&music)
	s.reader.QueryRow("SELECT id FROM media_libraries WHERE server_id=? AND external_id='8'", server).Scan(&shows)
	f := catalogueFixture{a: a, s: s, token: token, library: music}
	lib := responseData(t, apiRequest(a, "GET", f.path(""), token, nil, nil))["catalogue"].(map[string]any)
	if lib["tracks_supported"] != true {
		t.Fatal("Plex tracks not advertised", lib)
	}
	// "Albums + Tracks": the albums, then each album's tracks in the background.
	if started := f.startEpisodeSync(t)["episodes"].(map[string]any); started["started"] != true || started["shows"].(float64) != 1 {
		t.Fatal(started)
	}
	run := waitForLibraryIdle(t, f)["last_episode_run"].(map[string]any)
	if run["shows_synced"].(float64) != 1 || run["added"].(float64) != 4 || run["stopped"] != nil {
		t.Fatal(run)
	}
	var summaries int
	s.reader.QueryRow("SELECT count(*) FROM audit_events WHERE action='library.tracks.sync_all'").Scan(&summaries)
	if summaries != 1 {
		t.Fatal("track run not audited as a track run", summaries)
	}
	var album int64
	s.reader.QueryRow("SELECT id FROM media_items WHERE library_id=? AND external_id='77'", music).Scan(&album)
	detail := responseData(t, apiRequest(a, "GET", f.path(fmt.Sprintf("/media/%d", album)), token, nil, nil))
	if detail["track_catalogue_supported"] != true || detail["episode_catalogue_supported"] != false {
		t.Fatal("album capabilities", detail)
	}
	activityExec(t, s, "INSERT INTO identities(uuid,kind) VALUES('svc-listener','service')")
	activityExec(t, s, "INSERT INTO service_accounts(uuid,server_id,external_user_id,external_username,created_at,updated_at) VALUES('svc-listener',?,'listener','listener',?,?)", server, utcTimestamp(time.Now()), utcTimestamp(time.Now()))
	activityExec(t, s, `INSERT INTO media_activity_history(server_id,external_session_id,service_uuid,item_id,media_type,title,first_seen_at,last_seen_at,paused,parent_item_id,parent_title)
	 VALUES(?,'play-1','svc-listener','702','Audio','Single',?,?,0,'77','Fixture Album')`, server, utcTimestamp(time.Now()), utcTimestamp(time.Now()))

	w := apiRequest(a, "GET", f.path(fmt.Sprintf("/media/%d/tracks", album)), token, nil, nil)
	var list struct {
		Data struct {
			Tracks []struct {
				Title   string `json:"title"`
				Type    string `json:"item_type"`
				Disc    int64  `json:"season_number"`
				Number  int64  `json:"episode_number"`
				Streams int64  `json:"stream_count"`
			} `json:"tracks"`
			Revision int64 `json:"episode_revision"`
		} `json:"data"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &list) != nil {
		t.Fatal(w.Code, w.Body.String())
	}
	order := []string{}
	for _, track := range list.Data.Tracks {
		order = append(order, fmt.Sprintf("%d.%d %s %s %d", track.Disc, track.Number, track.Type, track.Title, track.Streams))
	}
	if strings.Join(order, " | ") != "1.1 track Intro 0 | 1.2 track Single 1 | 1.2 music_video Single (Official Video) 0 | 2.1 track Bonus 0" {
		t.Fatal(order)
	}
	// Episodes and tracks are each only for their own parents.
	if w := apiRequest(a, "GET", f.path(fmt.Sprintf("/media/%d/episodes", album)), token, nil, nil); w.Code != 409 || !strings.Contains(w.Body.String(), "NOT_A_SERIES") {
		t.Fatal(w.Code, w.Body.String())
	}
	showsFixture := catalogueFixture{a: a, s: s, token: token, library: shows}
	if w := apiRequest(a, "POST", showsFixture.path("/sync"), token, nil, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var show int64
	s.reader.QueryRow("SELECT id FROM media_items WHERE library_id=? AND external_id='55'", shows).Scan(&show)
	if w := apiRequest(a, "POST", showsFixture.path(fmt.Sprintf("/media/%d/tracks/sync", show)), token, nil, nil); w.Code != 409 || !strings.Contains(w.Body.String(), "NOT_AN_ALBUM") {
		t.Fatal(w.Code, w.Body.String())
	}
	// A single album syncs from its own page, and purges its tracks.
	if w := apiRequest(a, "POST", f.path(fmt.Sprintf("/media/%d/tracks/sync", album)), token, map[string]any{"expected_episode_revision": list.Data.Revision}, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := apiRequest(a, "POST", f.path(fmt.Sprintf("/media/%d/tracks/purge", album)), token, nil, nil); w.Code != 200 || f.episodeCount(t, "77") != 0 {
		t.Fatal(w.Code, w.Body.String())
	}
}

func TestJellyfinAlbumTracks(t *testing.T) {
	f := newCatalogueFixture(t, 0)
	f.upstream.mu.Lock()
	f.upstream.items = []map[string]any{{"Id": "album1", "Name": "Record", "Type": "MusicAlbum"}}
	f.upstream.episodes = map[string][]map[string]any{"album1": {
		{"Id": "t2", "Name": "Second", "Type": "Audio", "AlbumId": "album1", "ParentIndexNumber": 1, "IndexNumber": 2},
		{"Id": "t1", "Name": "First", "Type": "Audio", "AlbumId": "album1", "ParentIndexNumber": 1, "IndexNumber": 1},
	}}
	f.upstream.mu.Unlock()
	if w := apiRequest(f.a, "POST", f.path("/sync"), f.token, nil, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var album int64
	f.s.reader.QueryRow("SELECT id FROM media_items WHERE library_id=? AND external_id='album1'", f.library).Scan(&album)
	if w := apiRequest(f.a, "POST", f.path(fmt.Sprintf("/media/%d/tracks/sync", album)), f.token, nil, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var first string
	f.s.reader.QueryRow("SELECT title FROM media_items WHERE library_id=? AND parent_id='album1' AND item_type='track' ORDER BY episode_number LIMIT 1", f.library).Scan(&first)
	if first != "First" || f.episodeCount(t, "album1") != 2 {
		t.Fatal(first, f.episodeCount(t, "album1"))
	}
	// A track of another album rejects the snapshot and keeps the saved tracks.
	f.upstream.mu.Lock()
	f.upstream.episodes["album1"][0]["AlbumId"] = "album2"
	f.upstream.mu.Unlock()
	if w := apiRequest(f.a, "POST", f.path(fmt.Sprintf("/media/%d/tracks/sync", album)), f.token, nil, nil); w.Code != 502 || f.episodeCount(t, "album1") != 2 {
		t.Fatal(w.Code, f.episodeCount(t, "album1"))
	}
}
