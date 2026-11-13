package main

import (
	"database/sql"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func plexEpisodeXML(show string, section string, ids ...int) string {
	var b strings.Builder
	for _, id := range ids {
		fmt.Fprintf(&b, `<Video ratingKey="%d" type="episode" title="Episode %d" grandparentRatingKey="%s" parentIndex="1" index="%d" librarySectionID="%s" duration="1800000" addedAt="1700000000" thumb="/library/metadata/%d/thumb/5"/>`, id, id, show, id%100, section, id)
	}
	return b.String()
}

func TestPlexEpisodeAdapterReadsEveryEpisodeOfAShow(t *testing.T) {
	pages := 0
	p := plexCatalogueFixture(t, func(w http.ResponseWriter, r *http.Request) {
		pages++
		start, _ := strconv.Atoi(r.Header.Get("X-Plex-Container-Start"))
		if r.URL.Path != "/proxy/library/metadata/55/allLeaves" || r.Header.Get("X-Plex-Token") != "fixture-secret" || r.Header.Get("X-Plex-Container-Size") != "200" {
			t.Error("wrong episode request", r.URL, r.Header)
		}
		fmt.Fprintf(w, `<MediaContainer size="%d" totalSize="201" offset="%d" librarySectionID="8" grandparentRatingKey="55">`, min(200, 201-start), start)
		for n := start; n < min(start+200, 201); n++ {
			thumb := fmt.Sprintf("/library/metadata/%d/thumb/5", 1000+n)
			if n == 1 {
				thumb = "/library/metadata/55/thumb/5" // the show's poster, not the episode's own
			}
			fmt.Fprintf(w, `<Video ratingKey="%d" type="episode" title="Episode %d" grandparentRatingKey="55" parentIndex="%d" index="%d" librarySectionID="8" year="2021" rating="8.5" duration="1800000" addedAt="1700000000" thumb="%s"/>`, 1000+n, n, n/10+1, n%10+1, thumb)
		}
		fmt.Fprint(w, `</MediaContainer>`)
	})
	episodes, err := p.catalogueEpisodes(t.Context(), "55")
	if err != nil || len(episodes) != 201 || pages != 2 {
		t.Fatal(len(episodes), pages, err)
	}
	first := episodes[0]
	if first.ID != "1000" || first.Type != "episode" || first.Season == nil || *first.Season != 1 || first.Episode == nil || *first.Episode != 1 || first.DurationMS == nil || *first.DurationMS != 1800000 || first.ImageTag != "/library/metadata/1000/thumb/5" || first.AddedAt == "" {
		t.Fatal(first)
	}
	if episodes[1].ImageTag != "" {
		t.Fatal("another item's poster kept for an episode", episodes[1].ImageTag)
	}
	if last := episodes[200]; *last.Season != 21 || *last.Episode != 1 {
		t.Fatal(*last.Season, *last.Episode)
	}
}

func TestPlexEpisodeAdapterRefusesForeignOrIncompleteEpisodes(t *testing.T) {
	good := plexEpisodeXML("55", "8", 1001)
	cases := map[string]string{
		"another show":    `<MediaContainer size="1" totalSize="1" offset="0">` + plexEpisodeXML("56", "8", 1001) + `</MediaContainer>`,
		"no show":         `<MediaContainer size="1" totalSize="1" offset="0"><Video ratingKey="1001" type="episode" title="Orphan"/></MediaContainer>`,
		"not an episode":  `<MediaContainer size="1" totalSize="1" offset="0"><Video ratingKey="1001" type="movie" title="Film" grandparentRatingKey="55"/></MediaContainer>`,
		"season element":  `<MediaContainer size="1" totalSize="1" offset="0"><Directory ratingKey="1001" type="episode" title="Season" grandparentRatingKey="55"/></MediaContainer>`,
		"duplicate":       `<MediaContainer size="2" totalSize="2" offset="0">` + good + good + `</MediaContainer>`,
		"mixed sections":  `<MediaContainer size="2" totalSize="2" offset="0">` + good + plexEpisodeXML("55", "9", 1002) + `</MediaContainer>`,
		"too many":        `<MediaContainer size="0" totalSize="10001" offset="0"/>`,
		"short":           `<MediaContainer size="0" totalSize="1" offset="0"/>`,
		"missing paging":  `<MediaContainer>` + good + `</MediaContainer>`,
		"untitled":        `<MediaContainer size="1" totalSize="1" offset="0"><Video ratingKey="1001" type="episode" title=" " grandparentRatingKey="55"/></MediaContainer>`,
		"malformed":       `<MediaContainer`,
		"unexpected text": `<MediaContainer size="0" totalSize="0" offset="0">upstream error</MediaContainer>`,
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			p := plexCatalogueFixture(t, func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, body) })
			if episodes, err := p.catalogueEpisodes(t.Context(), "55"); err == nil || episodes != nil {
				t.Fatal("invalid episode list accepted", episodes, err)
			}
		})
	}
	t.Run("invalid show sends nothing", func(t *testing.T) {
		calls := 0
		p := plexCatalogueFixture(t, func(w http.ResponseWriter, r *http.Request) { calls++ })
		for _, show := range []string{"", "0", "01", "../55", "55?X-Plex-Token=x"} {
			if _, err := p.catalogueEpisodes(t.Context(), show); err == nil {
				t.Fatal(show)
			}
		}
		if calls != 0 {
			t.Fatal("invalid show sent HTTP", calls)
		}
	})
}

// plexEpisodeUpstream is a disposable Plex server with one show library
// (section 8) whose shows' episodes the test controls.
type plexEpisodeUpstream struct {
	mu       sync.Mutex
	shows    []int
	episodes map[string][]int
	failing  map[string]bool
	// during runs while a show's episodes are requested; a false result
	// abandons the response.
	during func(show string, r *http.Request) bool
}

func (u *plexEpisodeUpstream) set(show string, ids ...int) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.episodes[show] = ids
}

func (u *plexEpisodeUpstream) fail(show string, failing bool) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.failing[show] = failing
}

// mustAtoi gives each fixture show its own episode IDs.
func mustAtoi(v string) int {
	n, _ := strconv.Atoi(v)
	return n
}

func newPlexEpisodeRuntime(t *testing.T) (catalogueFixture, *plexEpisodeUpstream) {
	t.Helper()
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	u := &plexEpisodeUpstream{shows: []int{201, 202, 203}, episodes: map[string][]int{}, failing: map[string]bool{}}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Plex-Token") != "fixture-secret" {
			w.WriteHeader(401)
			return
		}
		switch path := r.URL.Path; {
		case path == "/proxy/":
			fmt.Fprint(w, `<MediaContainer friendlyName="Plex Fixture" version="1" machineIdentifier="fixture-machine"/>`)
		case path == "/proxy/library/sections":
			fmt.Fprint(w, `<MediaContainer><Directory key="8" title="Shows" type="show"/></MediaContainer>`)
		case path == "/proxy/library/sections/8/all":
			u.mu.Lock()
			shows := append([]int(nil), u.shows...)
			u.mu.Unlock()
			fmt.Fprintf(w, `<MediaContainer offset="0" size="%d" totalSize="%d" librarySectionID="8">`, len(shows), len(shows))
			for _, id := range shows {
				fmt.Fprintf(w, `<Directory ratingKey="%d" type="show" title="Show %d" thumb="/library/metadata/%d/thumb/1"/>`, id, id, id)
			}
			fmt.Fprint(w, `</MediaContainer>`)
		case path == "/proxy/library/sections/8/collections":
			fmt.Fprint(w, `<MediaContainer offset="0" size="0" totalSize="0"/>`)
		case strings.HasPrefix(path, "/proxy/library/metadata/") && strings.HasSuffix(path, "/allLeaves"):
			show := strings.TrimSuffix(strings.TrimPrefix(path, "/proxy/library/metadata/"), "/allLeaves")
			u.mu.Lock()
			during, failing, ids := u.during, u.failing[show], append([]int(nil), u.episodes[show]...)
			u.mu.Unlock()
			if during != nil && !during(show, r) {
				return
			}
			if failing {
				w.WriteHeader(500)
				return
			}
			fmt.Fprintf(w, `<MediaContainer offset="0" size="%d" totalSize="%d" librarySectionID="8">%s</MediaContainer>`, len(ids), len(ids), plexEpisodeXML(show, "8", ids...))
		default:
			t.Error("unexpected Plex fixture path", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(upstream.Close)
	id := createManagedServer(t, a, token, "plex", upstream.URL+"/proxy")
	if w := apiRequest(a, "POST", fmt.Sprintf("/api/servers/%d/sync-libraries", id), token, nil, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var library int64
	if err := s.reader.QueryRow("SELECT id FROM media_libraries WHERE server_id=? AND external_id='8'", id).Scan(&library); err != nil {
		t.Fatal(err)
	}
	return catalogueFixture{a: a, s: s, token: token, library: library}, u
}

// waitForLibraryIdle waits for the library's sync to finish and returns its
// final status.
func waitForLibraryIdle(t *testing.T, f catalogueFixture) map[string]any {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for {
		status := responseData(t, apiRequest(f.a, "GET", f.path("/sync-status"), f.token, nil, nil))
		if status["is_syncing"] == false {
			return status
		}
		if time.Now().After(deadline) {
			t.Fatal("library sync did not finish", status)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func (f catalogueFixture) episodeCount(t *testing.T, show string) int {
	t.Helper()
	var n int
	if err := f.s.reader.QueryRow("SELECT count(*) FROM media_items WHERE library_id=? AND parent_id=?", f.library, show).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func (f catalogueFixture) startEpisodeSync(t *testing.T) map[string]any {
	t.Helper()
	w := apiRequest(f.a, "POST", f.path("/sync?sync_episodes=true"), f.token, nil, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	return responseData(t, w)
}

func TestPlexLibraryEpisodeSyncSavesEachShowAndKeepsFailedShows(t *testing.T) {
	f, u := newPlexEpisodeRuntime(t)
	lib := responseData(t, apiRequest(f.a, "GET", f.path(""), f.token, nil, nil))
	if lib["catalogue"].(map[string]any)["episodes_supported"] != true {
		t.Fatal("Plex episode capability not advertised", lib["catalogue"])
	}
	if w := apiRequest(f.a, "POST", f.path("/sync?sync_episodes=yes"), f.token, nil, nil); w.Code != 400 {
		t.Fatal("unclear sync_episodes accepted", w.Code)
	}
	u.set("201", 2011, 2012)
	u.set("202", 2021)
	u.set("203", 2031, 2032, 2033)
	result := f.startEpisodeSync(t)
	if result["revision"].(float64) != 2 || result["result"].(map[string]any)["added"].(float64) != 3 {
		t.Fatal("shows not saved first", result)
	}
	if episodes := result["episodes"].(map[string]any); episodes["started"] != true || episodes["shows"].(float64) != 3 {
		t.Fatal(result["episodes"])
	}
	status := waitForLibraryIdle(t, f)
	run := status["last_episode_run"].(map[string]any)
	if run["shows_synced"].(float64) != 3 || run["shows_failed"].(float64) != 0 || run["added"].(float64) != 6 || run["stopped"] != nil {
		t.Fatal(run)
	}
	if f.episodeCount(t, "201") != 2 || f.episodeCount(t, "202") != 1 || f.episodeCount(t, "203") != 3 {
		t.Fatal("episodes not saved per show")
	}
	var seasons, numbered int
	f.s.reader.QueryRow("SELECT count(*),count(episode_number) FROM media_items WHERE library_id=? AND parent_id='203' AND season_number=1", f.library).Scan(&seasons, &numbered)
	if seasons != 3 || numbered != 3 {
		t.Fatal("season/episode numbers not saved", seasons, numbered)
	}
	var counted sql.NullInt64
	f.s.reader.QueryRow("SELECT episode_count FROM media_items WHERE library_id=? AND external_id='203'", f.library).Scan(&counted)
	if !counted.Valid || counted.Int64 != 3 {
		t.Fatal("show episode count not recorded")
	}

	// Second run: show 202 cannot be read, so its saved episodes stay; the
	// others still update.
	u.fail("202", true)
	u.set("201", 2011)
	u.set("203", 2031, 2032, 2033, 2034)
	f.startEpisodeSync(t)
	run = waitForLibraryIdle(t, f)["last_episode_run"].(map[string]any)
	if run["shows_synced"].(float64) != 2 || run["shows_failed"].(float64) != 1 || run["added"].(float64) != 1 || run["removed"].(float64) != 1 || run["stopped"] != nil {
		t.Fatal(run)
	}
	if f.episodeCount(t, "201") != 1 || f.episodeCount(t, "202") != 1 || f.episodeCount(t, "203") != 4 {
		t.Fatal("a failed show lost its episodes or another show was not updated")
	}
	var summaries, perShow int
	f.s.reader.QueryRow("SELECT count(*) FROM audit_events WHERE action='library.episodes.sync_all'").Scan(&summaries)
	f.s.reader.QueryRow("SELECT count(*) FROM audit_events WHERE action='library.episodes.sync'").Scan(&perShow)
	if summaries != 2 || perShow != 0 {
		t.Fatal("audit", summaries, perShow)
	}

	// A single show's episodes sync from its own page too.
	var show int64
	f.s.reader.QueryRow("SELECT id FROM media_items WHERE library_id=? AND external_id='201'", f.library).Scan(&show)
	u.set("201", 2011, 2012, 2013)
	w := apiRequest(f.a, "POST", f.path(fmt.Sprintf("/media/%d/episodes/sync", show)), f.token, nil, nil)
	if w.Code != 200 || f.episodeCount(t, "201") != 3 {
		t.Fatal(w.Code, w.Body.String())
	}
}

func TestPlexLibraryEpisodeSyncProgressAndBusyGuards(t *testing.T) {
	f, u := newPlexEpisodeRuntime(t)
	for _, show := range []string{"201", "202", "203"} {
		u.set(show, mustAtoi(show)*10+1)
	}
	entered, release := make(chan struct{}), make(chan struct{})
	u.during = func(show string, r *http.Request) bool {
		if show == "202" {
			close(entered)
			<-release
		}
		return true
	}
	f.startEpisodeSync(t)
	<-entered
	status := responseData(t, apiRequest(f.a, "GET", f.path("/sync-status"), f.token, nil, nil))
	progress := status["progress"].(map[string]any)
	if status["is_syncing"] != true || progress["phase"] != "episodes" || progress["shows_total"].(float64) != 3 || progress["shows_current"].(float64) != 1 {
		t.Fatal(status)
	}
	var show int64
	f.s.reader.QueryRow("SELECT id FROM media_items WHERE library_id=? AND external_id='203'", f.library).Scan(&show)
	for _, path := range []string{"/sync", "/purge", fmt.Sprintf("/media/%d/episodes/sync", show), fmt.Sprintf("/media/%d/episodes/purge", show)} {
		if w := apiRequest(f.a, "POST", f.path(path), f.token, nil, nil); w.Code != 409 || !strings.Contains(w.Body.String(), "CATALOGUE_SYNC_BUSY") {
			t.Fatal(path, w.Code, w.Body.String())
		}
	}
	close(release)
	if run := waitForLibraryIdle(t, f)["last_episode_run"].(map[string]any); run["shows_synced"].(float64) != 3 {
		t.Fatal(run)
	}
}

func TestPlexLibraryEpisodeSyncStopsOnShutdownKeepingFinishedShows(t *testing.T) {
	f, u := newPlexEpisodeRuntime(t)
	for _, show := range []string{"201", "202", "203"} {
		u.set(show, mustAtoi(show)*10+1, mustAtoi(show)*10+2)
	}
	entered := make(chan struct{})
	u.during = func(show string, r *http.Request) bool {
		if show == "202" {
			close(entered)
			<-r.Context().Done() // held until MUM gives up on the request
			return false
		}
		return true
	}
	f.startEpisodeSync(t)
	<-entered
	f.a.CloseCatalogue()
	status := responseData(t, apiRequest(f.a, "GET", f.path("/sync-status"), f.token, nil, nil))
	run := status["last_episode_run"].(map[string]any)
	if status["is_syncing"] != false || run["stopped"] != "shutdown" || run["shows_synced"].(float64) != 1 {
		t.Fatal(status)
	}
	if f.episodeCount(t, "201") != 2 || f.episodeCount(t, "202") != 0 || f.episodeCount(t, "203") != 0 {
		t.Fatal("shutdown lost a finished show or saved an unfinished one")
	}
	if w := apiRequest(f.a, "POST", f.path("/sync?sync_episodes=true"), f.token, nil, nil); w.Code != 503 {
		t.Fatal("sync admitted during shutdown", w.Code)
	}
}

func TestPlexLibraryEpisodeSyncStopsWhenLibraryOrAuthorityChanges(t *testing.T) {
	for _, tc := range []struct{ name, sql, stopped string }{
		{"configuration", "UPDATE media_servers SET config_revision=config_revision+1", "library_changed"},
		{"disabled server", "UPDATE media_servers SET is_active=0", "library_changed"},
		{"logout", "DELETE FROM app_sessions", "forbidden"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f, u := newPlexEpisodeRuntime(t)
			for _, show := range []string{"201", "202", "203"} {
				u.set(show, mustAtoi(show)*10+1)
			}
			requested := map[string]bool{}
			u.during = func(show string, r *http.Request) bool {
				u.mu.Lock()
				requested[show] = true
				u.mu.Unlock()
				if show == "201" {
					activityExec(t, f.s, tc.sql)
				}
				return true
			}
			f.startEpisodeSync(t)
			var run map[string]any
			deadline := time.Now().Add(15 * time.Second)
			for run == nil {
				f.a.catalogueMu.Lock()
				run = f.a.episodeOutcomes[f.library]
				f.a.catalogueMu.Unlock()
				if time.Now().After(deadline) {
					t.Fatal("run did not finish")
				}
				time.Sleep(10 * time.Millisecond)
			}
			u.mu.Lock()
			second := requested["202"]
			u.mu.Unlock()
			if run["stopped"] != tc.stopped || run["shows_synced"].(int) != 0 || second {
				t.Fatal(run, requested)
			}
			if f.episodeCount(t, "201") != 0 {
				t.Fatal("episodes saved after the library or authority changed")
			}
		})
	}
}
