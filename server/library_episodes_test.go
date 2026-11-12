package main

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func fixtureEpisodes(series string, n int, prefix string) []map[string]any {
	out := []map[string]any{}
	for i := 0; i < n; i++ {
		e := map[string]any{"Id": fmt.Sprintf("%s%03d", prefix, i), "Name": fmt.Sprintf("Episode %03d", i), "Type": "Episode", "SeriesId": series,
			"ParentIndexNumber": 1 + i/20, "IndexNumber": 1 + i%20, "ProductionYear": 2020 + i/20, "RunTimeTicks": 26000000000}
		if i%2 == 0 {
			e["ImageTags"] = map[string]string{"Primary": fmt.Sprintf("etag%03d", i)}
		}
		out = append(out, e)
	}
	return out
}

type episodeList struct {
	Data struct {
		Episodes []map[string]any `json:"episodes"`
		Revision int64            `json:"episode_revision"`
	} `json:"data"`
	Meta struct {
		Pagination struct {
			Total int `json:"total_items"`
			Pages int `json:"total_pages"`
		} `json:"pagination"`
	} `json:"meta"`
}

func TestEpisodeCatalogueSyncListAndIsolation(t *testing.T) {
	f := newCatalogueFixture(t, 3)
	f.upstream.mu.Lock()
	f.upstream.items = append(f.upstream.items, map[string]any{"Id": "show1", "Name": "The Show", "Type": "Series"})
	f.upstream.episodes = map[string][]map[string]any{"show1": fixtureEpisodes("show1", 30, "e")}
	f.upstream.mu.Unlock()
	if w := apiRequest(f.a, "POST", f.path("/sync"), f.token, nil, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var show, movie int64
	f.s.reader.QueryRow("SELECT id FROM media_items WHERE external_id='show1'").Scan(&show)
	f.s.reader.QueryRow("SELECT id FROM media_items WHERE external_id='a0000'").Scan(&movie)
	ep := func(item int64, suffix string) string {
		return f.path(fmt.Sprintf("/media/%d/episodes%s", item, suffix))
	}
	episodeCount := func() int {
		var n int
		f.s.reader.QueryRow("SELECT count(*) FROM media_items WHERE parent_id='show1'").Scan(&n)
		return n
	}
	list := func(query string) episodeList {
		t.Helper()
		w := apiRequest(f.a, "GET", ep(show, "?"+query), f.token, nil, nil)
		var out episodeList
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &out) != nil {
			t.Fatal(w.Code, w.Body.String())
		}
		return out
	}

	// Only series have episodes.
	for _, req := range [][2]string{{"GET", ep(movie, "")}, {"POST", ep(movie, "/sync")}, {"POST", ep(movie, "/purge")}} {
		if w := apiRequest(f.a, req[0], req[1], f.token, nil, nil); w.Code != 409 || !strings.Contains(w.Body.String(), "NOT_A_SERIES") {
			t.Fatal(req, w.Code, w.Body.String())
		}
	}
	detail := responseData(t, apiRequest(f.a, "GET", f.path(fmt.Sprintf("/media/%d", show)), f.token, nil, nil))
	if detail["episode_revision"].(float64) != 1 || detail["episodes_synced_at"] != nil || detail["item_type"] != "show" {
		t.Fatal(detail)
	}
	if w := apiRequest(f.a, "POST", ep(show, "/sync"), f.token, map[string]any{"expected_episode_revision": 2}, nil); w.Code != 409 {
		t.Fatal("stale episode revision accepted", w.Code)
	}
	synced := responseData(t, apiRequest(f.a, "POST", ep(show, "/sync"), f.token, map[string]any{"expected_episode_revision": 1}, nil))
	if counts := synced["result"].(map[string]any); counts["added"].(float64) != 30 || synced["revision"].(float64) != 2 {
		t.Fatal(synced)
	}

	page := list("page=1&page_size=12")
	first := page.Data.Episodes[0]
	if page.Meta.Pagination.Total != 30 || page.Meta.Pagination.Pages != 3 || page.Data.Revision != 2 || first["title"] != "Episode 000" || first["season_number"].(float64) != 1 || first["episode_number"].(float64) != 1 {
		t.Fatal(page.Meta, first)
	}
	if thumb, _ := first["thumb"].(string); !strings.HasPrefix(thumb, "/api/media/images/") || page.Data.Episodes[1]["thumb"] != nil {
		t.Fatal("episode posters", first, page.Data.Episodes[1])
	}
	if last := list("sort_by=season_episode_desc&page_size=1").Data.Episodes[0]; last["title"] != "Episode 029" {
		t.Fatal(last)
	}
	if found := list("search=episode%2002"); found.Meta.Pagination.Total != 10 {
		t.Fatal(found.Meta)
	}
	if w := apiRequest(f.a, "GET", ep(show, "?sort_by=total_streams_desc"), f.token, nil, nil); w.Code != 400 {
		t.Fatal(w.Code)
	}

	// Episodes stay out of the library list, count and resync, and their posters work.
	if items := f.list(t, "page_size=100"); items.Meta.Pagination.Total != 4 {
		t.Fatal("episodes leaked into the library list", items.Meta.Pagination.Total)
	}
	if again := responseData(t, apiRequest(f.a, "POST", f.path("/sync"), f.token, nil, nil))["result"].(map[string]any); again["added"].(float64) != 0 || again["removed"].(float64) != 0 || episodeCount() != 30 {
		t.Fatal("library resync touched episodes", again, episodeCount())
	}
	if img := apiRequest(f.a, "GET", first["thumb"].(string), "", nil, nil); img.Code != 200 {
		t.Fatal("episode poster", img.Code)
	}

	// Upstream changes are reported exactly.
	f.upstream.mu.Lock()
	changed := fixtureEpisodes("show1", 25, "e")
	changed[0]["Name"] = "Renamed pilot"
	f.upstream.episodes["show1"] = append(changed, fixtureEpisodes("show1", 2, "n")...)
	f.upstream.mu.Unlock()
	counts := responseData(t, apiRequest(f.a, "POST", ep(show, "/sync"), f.token, nil, nil))["result"].(map[string]any)
	if counts["added"].(float64) != 2 || counts["updated"].(float64) != 1 || counts["removed"].(float64) != 5 || episodeCount() != 27 {
		t.Fatal(counts, episodeCount())
	}

	// A wrong series ID or an ID already used by a library item rejects the snapshot.
	for name, c := range map[string]struct {
		bad  func([]map[string]any)
		code int
	}{
		"wrong series":       {func(e []map[string]any) { e[3]["SeriesId"] = "other" }, 502},
		"collides with film": {func(e []map[string]any) { e[3]["Id"] = "a0000" }, 409},
	} {
		episodes := fixtureEpisodes("show1", 27, "e")
		c.bad(episodes)
		f.upstream.mu.Lock()
		f.upstream.episodes["show1"] = episodes
		f.upstream.mu.Unlock()
		if w := apiRequest(f.a, "POST", ep(show, "/sync"), f.token, nil, nil); w.Code != c.code {
			t.Fatal(name, w.Code, w.Body.String())
		}
		var title string
		f.s.reader.QueryRow("SELECT title FROM media_items WHERE external_id='a0000'").Scan(&title)
		if episodeCount() != 27 || title != "Movie 0000" {
			t.Fatal(name, "changed stored rows", episodeCount(), title)
		}
	}

	// Plays of an episode without a series never attribute to the episode row.
	var server int64
	f.s.reader.QueryRow("SELECT server_id FROM media_libraries WHERE id=?", f.library).Scan(&server)
	activityExec(t, f.s, "INSERT INTO identities(uuid,kind) VALUES('svc-ep','service')")
	activityExec(t, f.s, "INSERT INTO service_accounts(uuid,server_id,external_user_id,created_at,updated_at) VALUES('svc-ep',?,'ep-user','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')", server)
	activityExec(t, f.s, "INSERT INTO media_activity_history(server_id,external_session_id,service_uuid,item_id,media_type,title,first_seen_at,last_seen_at,ended_at,end_reason,paused) VALUES(?,'x','svc-ep','e001','Episode','Episode 001',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),'not_observed',0)", server)
	if stats := responseData(t, apiRequest(f.a, "GET", f.path("/stats"), f.token, nil, nil))["stats"].(map[string]any); stats["total_streams"].(float64) != 0 {
		t.Fatal("parentless episode attributed", stats)
	}

	// Purge with the current revision, then a removed series takes its episodes with it.
	revision := list("").Data.Revision
	if w := apiRequest(f.a, "POST", ep(show, "/purge"), f.token, map[string]any{"expected_episode_revision": revision - 1}, nil); w.Code != 409 {
		t.Fatal("stale purge accepted", w.Code)
	}
	purged := responseData(t, apiRequest(f.a, "POST", ep(show, "/purge"), f.token, map[string]any{"expected_episode_revision": revision}, nil))
	if purged["deleted_count"].(float64) != 27 || episodeCount() != 0 {
		t.Fatal(purged)
	}
	f.upstream.episodes["show1"] = fixtureEpisodes("show1", 4, "e")
	if w := apiRequest(f.a, "POST", ep(show, "/sync"), f.token, nil, nil); w.Code != 200 || episodeCount() != 4 {
		t.Fatal(w.Code, episodeCount())
	}
	f.upstream.mu.Lock()
	f.upstream.items = f.upstream.items[:3]
	f.upstream.mu.Unlock()
	if removed := responseData(t, apiRequest(f.a, "POST", f.path("/sync"), f.token, nil, nil))["result"].(map[string]any); removed["removed"].(float64) != 1 || episodeCount() != 0 {
		t.Fatal("removed series kept its episodes", removed, episodeCount())
	}
	var audits int
	f.s.reader.QueryRow("SELECT count(*) FROM audit_events WHERE action IN ('library.episodes.sync','library.episodes.purge')").Scan(&audits)
	if audits != 4 {
		t.Fatal("episode audits", audits)
	}
}
