package main

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"testing"
)

func TestPlexCollectionsAdapterCompleteSnapshot(t *testing.T) {
	p := plexCatalogueFixture(t, func(w http.ResponseWriter, r *http.Request) {
		start, _ := strconv.Atoi(r.Header.Get("X-Plex-Container-Start"))
		if r.URL.Path != "/proxy/library/sections/7/collections" || r.Header.Get("X-Plex-Token") != "fixture-secret" || r.URL.Query().Get("X-Plex-Token") != "" {
			t.Error("wrong collection request", r.URL, r.Header)
		}
		if start == 0 {
			fmt.Fprint(w, `<MediaContainer offset="0" size="2" totalSize="3"><Directory ratingKey="50" type="collection" subtype="movie" title="Heists" titleSort="Heist" childCount="4" smart="1" addedAt="1700000000" thumb="/library/collections/50/composite/1700000001"/><Directory ratingKey="51" type="collection" title="Custom" childCount="0" thumb="/library/metadata/51/thumb/9"/></MediaContainer>`)
			return
		}
		fmt.Fprint(w, `<MediaContainer offset="2" size="1" totalSize="3"><Directory ratingKey="52" type="collection" title="Odd poster" thumb="https://evil.example/x.png"/></MediaContainer>`)
	})
	got, err := p.plexCatalogueCollections(context.Background(), "7", "movie")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 || got[0].ID != "50" || got[0].SortTitle != "Heist" || got[0].ChildCount == nil || *got[0].ChildCount != 4 || !got[0].Smart || got[0].AddedAt == "" || got[0].ImageTag != "/library/collections/50/composite/1700000001" {
		t.Fatal("first collection mapping", got)
	}
	if got[1].Smart || got[1].ImageTag != "/library/metadata/51/thumb/9" || got[1].SortTitle != "Custom" {
		t.Fatal("second collection mapping", got[1])
	}
	// An unrecognized poster reference is dropped, never fetched.
	if got[2].ImageTag != "" {
		t.Fatal("foreign poster retained", got[2])
	}
}

func TestPlexCollectionsAdapterRejectsIncompleteSnapshots(t *testing.T) {
	for name, body := range map[string]string{
		"missing pagination": `<MediaContainer size="1"><Directory ratingKey="50" type="collection" title="A"/></MediaContainer>`,
		"short total":        `<MediaContainer offset="0" size="1" totalSize="2"><Directory ratingKey="50" type="collection" title="A"/></MediaContainer><!-- -->`,
		"duplicate":          `<MediaContainer offset="0" size="2" totalSize="2"><Directory ratingKey="50" type="collection" title="A"/><Directory ratingKey="50" type="collection" title="B"/></MediaContainer>`,
		"wrong type":         `<MediaContainer offset="0" size="1" totalSize="1"><Directory ratingKey="50" type="movie" title="A"/></MediaContainer>`,
		"wrong element":      `<MediaContainer offset="0" size="1" totalSize="1"><Video ratingKey="50" type="collection" title="A"/></MediaContainer>`,
		"bad id":             `<MediaContainer offset="0" size="1" totalSize="1"><Directory ratingKey="../50" type="collection" title="A"/></MediaContainer>`,
		"empty title":        `<MediaContainer offset="0" size="1" totalSize="1"><Directory ratingKey="50" type="collection" title=" "/></MediaContainer>`,
		"wrong section":      `<MediaContainer offset="0" size="1" totalSize="1" librarySectionID="8"><Directory ratingKey="50" type="collection" title="A"/></MediaContainer>`,
		"negative children":  `<MediaContainer offset="0" size="1" totalSize="1"><Directory ratingKey="50" type="collection" title="A" childCount="-1"/></MediaContainer>`,
		"error root":         `<Response code="401" status="Unauthorized"/>`,
	} {
		t.Run(name, func(t *testing.T) {
			calls := 0
			p := plexCatalogueFixture(t, func(w http.ResponseWriter, r *http.Request) {
				calls++
				if calls > 2 {
					w.WriteHeader(500)
					return
				}
				start := r.Header.Get("X-Plex-Container-Start")
				if name == "short total" && start != "0" {
					fmt.Fprint(w, `<MediaContainer offset="1" size="0" totalSize="2"></MediaContainer>`)
					return
				}
				fmt.Fprint(w, body)
			})
			if got, err := p.plexCatalogueCollections(context.Background(), "7", "movie"); err == nil {
				t.Fatal("incomplete snapshot accepted", got)
			}
		})
	}
}

func TestPlexCollectionsAdapterRefusesUnsupportedBeforeHTTP(t *testing.T) {
	calls := 0
	p := plexCatalogueFixture(t, func(http.ResponseWriter, *http.Request) { calls++ })
	for _, tc := range [][2]string{{"7", "artist"}, {"x", "movie"}, {"07", "show"}} {
		if _, err := p.plexCatalogueCollections(context.Background(), tc[0], tc[1]); err == nil {
			t.Fatal("unsupported section admitted", tc)
		}
	}
	for _, tc := range [][2]string{{"50", "/library/collections/51/composite/1"}, {"50", "/library/metadata/50/art/1"}, {"50", "/library/collections/50/composite/1?x=1"}, {"x", "/library/collections/x/composite/1"}} {
		if _, _, err := p.plexCollectionImage(context.Background(), tc[0], tc[1]); err == nil {
			t.Fatal("unbound poster admitted", tc)
		}
	}
	if calls != 0 {
		t.Fatal("request sent for refused input", calls)
	}
}

func TestPlexCollectionImageFetchesBoundComposite(t *testing.T) {
	p := plexCatalogueFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/proxy/library/collections/50/composite/7" {
			t.Error("unexpected poster path", r.URL.Path)
		}
		w.Header().Set("Content-Type", "image/jpeg")
		fmt.Fprint(w, "composite")
	})
	kind, body, err := p.plexCollectionImage(context.Background(), "50", "/library/collections/50/composite/7")
	if err != nil || kind != "image/jpeg" || string(body) != "composite" {
		t.Fatal(kind, string(body), err)
	}
}

func TestPlexCollectionsRuntimeSyncListImageAndPurge(t *testing.T) {
	hooks := &plexRuntimeHooks{}
	f, _ := newPlexRuntime(t, nil, hooks)
	lib := responseData(t, apiRequest(f.a, "GET", f.path(""), f.token, nil, nil))
	if lib["catalogue"].(map[string]any)["collections_supported"] != true {
		t.Fatal("Plex movie collection capability missing", lib)
	}
	if w := apiRequest(f.a, "POST", f.path("/sync"), f.token, map[string]any{"expected_catalogue_revision": 1}, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	w := apiRequest(f.a, "GET", f.path("/collections"), f.token, nil, nil)
	collections := responseData(t, w)["collections"].([]any)
	if w.Code != 200 || len(collections) != 1 {
		t.Fatal(w.Code, w.Body.String())
	}
	c := collections[0].(map[string]any)
	thumb, _ := c["thumb"].(string)
	if c["title"] != "Fixture Collection" || c["child_count"] != float64(2) || c["smart"] != true || c["added_at"] == nil || len(thumb) < 30 || thumb[:29] != "/api/media/collections/images" {
		t.Fatal("collection DTO", c)
	}
	image := apiRequest(f.a, "GET", thumb, "", nil, nil)
	if image.Code != 200 || image.Body.String() != "fixture-composite" || image.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatal(image.Code, image.Body.String())
	}
	// A collection signature is not an item signature, and vice versa.
	if w := apiRequest(f.a, "GET", "/api/media/images/"+thumb[len("/api/media/collections/images/"):], "", nil, nil); w.Code != 403 {
		t.Fatal("collection link accepted as item link", w.Code)
	}
	list := f.list(t, "")
	if w := apiRequest(f.a, "GET", "/api/media/collections/images/"+list.Data[0].Thumb[len("/api/media/images/"):], "", nil, nil); w.Code != 403 {
		t.Fatal("item link accepted as collection link", w.Code)
	}
	if w := apiRequest(f.a, "POST", f.path("/purge"), f.token, map[string]any{"expected_catalogue_revision": 2}, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := apiRequest(f.a, "GET", f.path("/collections"), f.token, nil, nil); len(responseData(t, w)["collections"].([]any)) != 0 {
		t.Fatal("purge retained collections", w.Body.String())
	}
	if w := apiRequest(f.a, "GET", thumb, "", nil, nil); w.Code != 404 {
		t.Fatal("purged collection poster delivered", w.Code)
	}
}

func TestPlexCollectionsRuntimeFailedSnapshotRetainsCatalogue(t *testing.T) {
	hooks := &plexRuntimeHooks{}
	f, _ := newPlexRuntime(t, nil, hooks)
	if w := apiRequest(f.a, "POST", f.path("/sync"), f.token, nil, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	activityExec(t, f.s, "UPDATE media_collections SET title='Saved'")
	hooks.collectionsFail.Store(true)
	if w := apiRequest(f.a, "POST", f.path("/sync"), f.token, nil, nil); w.Code != 502 {
		t.Fatal("failed collection page accepted", w.Code, w.Body.String())
	}
	var title string
	var revision int64
	f.s.reader.QueryRow("SELECT title FROM media_collections").Scan(&title)
	f.s.reader.QueryRow("SELECT catalogue_revision FROM media_libraries WHERE id=?", f.library).Scan(&revision)
	if title != "Saved" || revision != 2 || f.itemCount(t) != 1 {
		t.Fatal("failed snapshot overwrote saved catalogue", title, revision)
	}
}

func TestPlexCollectionsRuntimeUnsupportedAndAuthority(t *testing.T) {
	hooks := &plexRuntimeHooks{}
	f, _ := newPlexRuntime(t, nil, hooks)
	var music int64
	f.s.reader.QueryRow("SELECT id FROM media_libraries WHERE external_id='9'").Scan(&music)
	if w := apiRequest(f.a, "GET", fmt.Sprintf("/api/libraries/%d", music), f.token, nil, nil); responseData(t, w)["catalogue"].(map[string]any)["collections_supported"] != false {
		t.Fatal("music collections advertised")
	}
	if w := apiRequest(f.a, "GET", fmt.Sprintf("/api/libraries/%d/collections", music), f.token, nil, nil); w.Code != 409 {
		t.Fatal("unsupported collections read admitted", w.Code)
	}
	if w := apiRequest(f.a, "GET", f.path("/collections"), "", nil, nil); w.Code != 401 {
		t.Fatal("anonymous collections read admitted", w.Code)
	}
	if w := apiRequest(f.a, "POST", f.path("/sync"), f.token, nil, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	thumb := responseData(t, apiRequest(f.a, "GET", f.path("/collections"), f.token, nil, nil))["collections"].([]any)[0].(map[string]any)["thumb"].(string)
	// Revocation while the provider answers must withhold the poster.
	hooks.duringImage = func(s *Store) { activityExec(t, s, "DELETE FROM app_sessions") }
	if w := apiRequest(f.a, "GET", thumb, "", nil, nil); w.Code != 403 {
		t.Fatal("poster delivered after logout", w.Code, w.Body.String())
	}
}
