package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

// plexRuntimeHooks lets collection tests fail the collection page or act
// while a composite poster is being fetched.
type plexRuntimeHooks struct {
	collectionsFail atomic.Bool
	duringImage     func(*Store)
}

func newPlexCatalogueRuntime(t *testing.T, duringRead func(*Store)) (catalogueFixture, *atomic.Int32) {
	t.Helper()
	return newPlexRuntime(t, duringRead, &plexRuntimeHooks{})
}

func newPlexRuntime(t *testing.T, duringRead func(*Store), hooks *plexRuntimeHooks) (catalogueFixture, *atomic.Int32) {
	t.Helper()
	a, s := testApp(t)
	token, _ := bootstrapOwner(t, a)
	hits := atomic.Int32{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Plex-Token") != "fixture-secret" {
			t.Error("missing header credential")
			w.WriteHeader(401)
			return
		}
		switch r.URL.Path {
		case "/proxy/":
			fmt.Fprint(w, `<MediaContainer friendlyName="Plex Fixture" version="1" machineIdentifier="fixture-machine"/>`)
		case "/proxy/library/sections":
			fmt.Fprint(w, `<MediaContainer><Directory key="7" title="Movies" type="movie"/><Directory key="8" title="Shows" type="show"/><Directory key="9" title="Music" type="artist"/></MediaContainer>`)
		case "/proxy/library/sections/7/all", "/proxy/library/sections/8/all":
			hits.Add(1)
			if duringRead != nil {
				duringRead(s)
			}
			kind, element := "movie", "Video"
			if strings.Contains(r.URL.Path, "/8/") {
				kind, element = "show", "Directory"
			}
			fmt.Fprintf(w, `<MediaContainer offset="0" size="1" totalSize="1"><%s ratingKey="123" type="%s" title="Plex Fixture Item" thumb="/library/metadata/123/thumb/1"/></MediaContainer>`, element, kind)
		case "/proxy/library/sections/7/collections", "/proxy/library/sections/8/collections":
			if hooks.collectionsFail.Load() {
				w.WriteHeader(500)
				return
			}
			fmt.Fprint(w, `<MediaContainer offset="0" size="1" totalSize="1"><Directory ratingKey="900" type="collection" title="Fixture Collection" childCount="2" smart="1" addedAt="1700000000" thumb="/library/collections/900/composite/5"/></MediaContainer>`)
		case "/proxy/library/collections/900/composite/5":
			if hooks.duringImage != nil {
				hooks.duringImage(s)
			}
			w.Header().Set("Content-Type", "image/jpeg")
			fmt.Fprint(w, "fixture-composite")
		case "/proxy/library/metadata/123/thumb/1":
			w.Header().Set("Content-Type", "image/png")
			fmt.Fprint(w, "fixture-poster")
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
	if err := s.reader.QueryRow("SELECT id FROM media_libraries WHERE server_id=? AND external_id='7'", id).Scan(&library); err != nil {
		t.Fatal(err)
	}
	return catalogueFixture{a: a, s: s, token: token, library: library}, &hits
}

func TestPlexCatalogueRuntimeSyncImagesAndCapabilityBoundaries(t *testing.T) {
	f, hits := newPlexCatalogueRuntime(t, nil)
	lib := responseData(t, apiRequest(f.a, "GET", f.path(""), f.token, nil, nil))
	if lib["catalogue"].(map[string]any)["supported"] != true {
		t.Fatal("Plex movie capability missing", lib)
	}
	if w := apiRequest(f.a, "POST", f.path("/sync"), f.token, map[string]any{"expected_catalogue_revision": 1}, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	list := f.list(t, "")
	if len(list.Data) != 1 || list.Data[0].Title != "Plex Fixture Item" || !strings.HasPrefix(list.Data[0].Thumb, "/api/media/images/") {
		t.Fatal(list)
	}
	detail := responseData(t, apiRequest(f.a, "GET", f.path(fmt.Sprintf("/media/%d", list.Data[0].ID)), f.token, nil, nil))
	if detail["catalogue_supported"] != true || detail["episode_catalogue_supported"] != false {
		t.Fatal("capabilities conflated", detail)
	}
	image := apiRequest(f.a, "GET", list.Data[0].Thumb, "", nil, nil)
	if image.Code != 200 || image.Body.String() != "fixture-poster" || image.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatal(image.Code, image.Body.String())
	}
	var music, shows int64
	f.s.reader.QueryRow("SELECT id FROM media_libraries WHERE external_id='9'").Scan(&music)
	f.s.reader.QueryRow("SELECT id FROM media_libraries WHERE external_id='8'").Scan(&shows)
	w := apiRequest(f.a, "GET", fmt.Sprintf("/api/libraries/%d", music), f.token, nil, nil)
	if responseData(t, w)["catalogue"].(map[string]any)["supported"] != false {
		t.Fatal("unsupported music advertised")
	}
	if w := apiRequest(f.a, "POST", fmt.Sprintf("/api/libraries/%d/sync", music), f.token, nil, nil); w.Code != 409 {
		t.Fatal("music sync admitted", w.Code)
	}
	if hits.Load() != 1 {
		t.Fatal("unsupported provider request sent", hits.Load())
	}
	if w := apiRequest(f.a, "POST", fmt.Sprintf("/api/libraries/%d/sync", shows), f.token, nil, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var show int64
	f.s.reader.QueryRow("SELECT id FROM media_items WHERE library_id=?", shows).Scan(&show)
	// Plex shows have episode catalogues (plex_episodes_test.go covers syncing).
	if w := apiRequest(f.a, "POST", fmt.Sprintf("/api/libraries/%d/media/%d/episodes/purge", shows, show), f.token, nil, nil); w.Code != 200 {
		t.Fatal("Plex episode purge refused", w.Code, w.Body.String())
	}
	if w := apiRequest(f.a, "POST", f.path("/purge"), f.token, map[string]any{"expected_catalogue_revision": 2}, nil); w.Code != 200 || f.itemCount(t) != 0 {
		t.Fatal("purge", w.Code, w.Body.String())
	}
}

func TestPlexCatalogueRuntimeRechecksAfterProviderIO(t *testing.T) {
	for _, tc := range []struct {
		name, sql string
		status    int
	}{
		{"logout", "DELETE FROM app_sessions", 403},
		{"kind", "UPDATE media_libraries SET library_type='artist'", 409},
		{"configuration", "UPDATE media_servers SET config_revision=config_revision+1", 409},
		{"catalogue revision", "UPDATE media_libraries SET catalogue_revision=catalogue_revision+1", 409},
		{"unavailable", "UPDATE media_libraries SET is_available=0", 404},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f, _ := newPlexCatalogueRuntime(t, func(s *Store) { activityExec(t, s, tc.sql) })
			w := apiRequest(f.a, "POST", f.path("/sync"), f.token, nil, nil)
			if w.Code != tc.status || f.itemCount(t) != 0 {
				t.Fatal("stale snapshot committed", w.Code, w.Body.String())
			}
		})
	}
}
