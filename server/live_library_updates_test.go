package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"app/server/providers/provider"
	"github.com/coder/websocket"
)

// A Plex server announces a changed episode: MUM reads again only that
// library, and in it only that episode's show, without moving the next
// scheduled refresh; a running refresh makes the changes wait.
func TestLiveLibraryUpdateReadsOnlyWhatChanged(t *testing.T) {
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	var mu sync.Mutex
	hits := map[string]int{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		hits[r.URL.Path]++
		mu.Unlock()
		w.Header().Set("Content-Type", "application/xml")
		switch r.URL.Path {
		case "/":
			fmt.Fprint(w, `<MediaContainer friendlyName="Plex Fixture" version="1" machineIdentifier="fixture-machine"/>`)
		case "/library/sections":
			fmt.Fprint(w, `<MediaContainer><Directory key="7" title="Movies" type="movie"/><Directory key="8" title="Shows" type="show"/></MediaContainer>`)
		case "/library/sections/7/all":
			fmt.Fprint(w, `<MediaContainer offset="0" size="1" totalSize="1"><Video ratingKey="100" type="movie" title="Film"/></MediaContainer>`)
		case "/library/sections/8/all":
			fmt.Fprint(w, `<MediaContainer offset="0" size="2" totalSize="2"><Directory ratingKey="201" type="show" title="First Show"/><Directory ratingKey="202" type="show" title="Second Show"/></MediaContainer>`)
		case "/library/sections/7/collections", "/library/sections/8/collections":
			fmt.Fprint(w, `<MediaContainer offset="0" size="0" totalSize="0"/>`)
		case "/library/metadata/201/allLeaves", "/library/metadata/202/allLeaves":
			show := r.URL.Path[len("/library/metadata/") : len("/library/metadata/")+3]
			fmt.Fprintf(w, `<MediaContainer offset="0" size="1" totalSize="1"><Video ratingKey="%s1" type="episode" title="Pilot" grandparentRatingKey="%s" parentIndex="1" index="1"/></MediaContainer>`, show, show)
		case "/library/metadata/2015":
			fmt.Fprint(w, `<MediaContainer size="1"><Video ratingKey="2015" type="episode" grandparentRatingKey="201" parentRatingKey="2010"/></MediaContainer>`)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer upstream.Close()
	id := createManagedServer(t, a, token, "plex", upstream.URL)
	if w := apiRequest(a, "POST", fmt.Sprintf("/api/servers/%d/sync-libraries", id), token, nil, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	activityExec(t, s, "UPDATE server_refresh_settings SET include_episodes_and_tracks=1 WHERE server_id=?", id)
	activityExec(t, s, "UPDATE server_refresh_schedules SET next_run_at='2099-01-01T00:00:00Z' WHERE server_id=?", id)
	due := func(changes ...provider.LibraryChange) {
		t.Helper()
		a.noteLibraryChanges(id, changes)
		a.liveLibraries.mu.Lock()
		a.liveLibraries.servers[id].last = time.Now().Add(-liveLibraryQuiet)
		a.liveLibraries.mu.Unlock()
	}
	run := func() {
		t.Helper()
		mu.Lock()
		clear(hits)
		mu.Unlock()
		if err := a.runDueLiveLibraryUpdate(t.Context()); err != nil {
			t.Fatal(err)
		}
	}

	// A new show: the library is read and, as both shows are new to MUM,
	// both shows' episodes.
	due(provider.LibraryChange{Library: "8", Item: "201", Kind: "show"})
	run()
	if hits["/library/sections/8/all"] != 1 || hits["/library/sections/7/all"] != 0 || hits["/library/metadata/201/allLeaves"] != 1 || hits["/library/metadata/202/allLeaves"] != 1 {
		t.Fatal("first run", hits)
	}

	// A new episode of the first show: only that show's episodes.
	due(provider.LibraryChange{Library: "8", Item: "2015", Kind: "episode"})
	run()
	if hits["/library/sections/8/all"] != 1 || hits["/library/metadata/2015"] != 1 || hits["/library/metadata/201/allLeaves"] != 1 || hits["/library/metadata/202/allLeaves"] != 0 || hits["/library/sections/7/all"] != 0 {
		t.Fatal("episode run", hits)
	}
	var next, state, code string
	if err := s.reader.QueryRow("SELECT next_run_at,run_state,last_code FROM server_refresh_schedules WHERE server_id=? AND scope='libraries'", id).Scan(&next, &state, &code); err != nil || next != "2099-01-01T00:00:00Z" || state != "succeeded" || code != "SUCCEEDED" {
		t.Fatal("schedule changed by a live run", next, state, code, err)
	}
	runs := refreshRunLog(t, a, token, id, "libraries")
	if len(runs) == 0 || !runLogHas(runs[0], refreshLogInformation, "Started by changes the server announced") {
		t.Fatal("live run not described in the run log", runs)
	}

	// While a refresh is running the changes wait instead of running.
	activityExec(t, s, "UPDATE server_refresh_schedules SET run_state='running',claim_token='other-run',runner_id='other-runner',lease_until='2099-01-01T00:00:00Z' WHERE server_id=? AND scope='libraries'", id)
	due(provider.LibraryChange{Library: "7", Item: "100", Kind: "movie"})
	run()
	if hits["/library/sections/7/all"] != 0 {
		t.Fatal("ran during another refresh", hits)
	}
	a.liveLibraries.mu.Lock()
	waiting := a.liveLibraries.servers[id]
	a.liveLibraries.mu.Unlock()
	if waiting == nil || len(waiting.changes) != 1 {
		t.Fatal("changes dropped while busy", waiting)
	}
}

// A Plex live connection's library announcements are collected for the
// server, and a dropped connection gets the server checked straight away
// instead of at its next regular check.
func TestPlexSocketCollectsLibraryChangesAndChecksHealthOnDrop(t *testing.T) {
	oldInterval := serverHealthInterval
	serverHealthInterval = time.Hour // only the drop may check the server
	t.Cleanup(func() { serverHealthInterval = oldInterval })
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	var probes atomic.Int64
	drop := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/proxy/":
			probes.Add(1)
			fmt.Fprint(w, `<MediaContainer friendlyName="Plex Fixture" version="1" machineIdentifier="fixture-machine"/>`)
		case "/proxy/library/sections":
			fmt.Fprint(w, `<MediaContainer><Directory key="7" title="Movies" type="movie"/></MediaContainer>`)
		case "/proxy/status/sessions":
			fmt.Fprint(w, `<MediaContainer size="0"/>`)
		case "/proxy/:/websockets/notifications":
			c, err := websocket.Accept(w, r, nil)
			if err != nil {
				return
			}
			defer c.CloseNow()
			_ = c.Write(r.Context(), websocket.MessageBinary, []byte(`{"NotificationContainer":{"type":"timeline","TimelineEntry":[{"identifier":"com.plexapp.plugins.library","sectionID":"7","itemID":"100","type":1,"state":5}]}}`))
			select {
			case <-drop:
			case <-r.Context().Done():
			}
		default:
			w.WriteHeader(404)
		}
	}))
	defer func() { a.CloseScheduler(); upstream.Close() }()
	server := createManagedServer(t, a, token, "plex", upstream.URL+"/proxy")
	view := monitorSnapshot(t, a, token)
	task := view["tasks"].([]any)[0].(map[string]any)
	body := monitorChange(view["actor_uuid"].(string), task, true)
	body["socket_enabled"] = true
	body["interval_seconds"] = 300
	if w := apiRequest(a, "PUT", fmt.Sprintf("/api/settings/activity-monitoring/%d", server), token, body, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	activityExec(t, s, "UPDATE media_servers SET last_status_check=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?", server)
	activityExec(t, s, "UPDATE server_refresh_schedules SET next_run_at='2099-01-01T00:00:00Z' WHERE server_id=?", server)
	if err := a.StartScheduler(); err != nil {
		t.Fatal(err)
	}
	waitProviderSocket(t, func() bool {
		a.liveLibraries.mu.Lock()
		defer a.liveLibraries.mu.Unlock()
		p := a.liveLibraries.servers[server]
		return p != nil && len(p.changes) == 1 && p.changes[0] == provider.LibraryChange{Library: "7", Item: "100", Kind: "movie"}
	})
	before := probes.Load()
	close(drop)
	waitProviderSocket(t, func() bool { return probes.Load() > before })
}
