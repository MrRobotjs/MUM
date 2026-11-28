package plex

import (
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"app/server/providers/provider"
)

// Finished and removed library items are read from a timeline notification;
// unfinished, unknown or non-library entries are skipped.
func TestLiveLibraryChanges(t *testing.T) {
	s := New(provider.Config{URL: "https://media.example", APIKey: "private-token"})
	changes, err := s.LiveLibraryChanges([]byte(`{"NotificationContainer":{"type":"timeline","size":6,"TimelineEntry":[
		{"identifier":"com.plexapp.plugins.library","sectionID":"1","itemID":"101","type":1,"state":5,"title":"never kept"},
		{"identifier":"com.plexapp.plugins.library","sectionID":2,"itemID":202,"type":4,"state":9,"metadataState":"deleted"},
		{"identifier":"com.plexapp.plugins.library","sectionID":"2","itemID":"203","type":4,"state":0,"metadataState":"created"},
		{"identifier":"com.plexapp.plugins.library","sectionID":"2","itemID":"204","type":12,"state":5},
		{"identifier":"com.plexapp.plugins.library","sectionID":"-1","itemID":"205","type":1,"state":5},
		{"identifier":"com.plexapp.system","sectionID":"1","itemID":"206","type":1,"state":5}]}}`))
	want := []provider.LibraryChange{{Library: "1", Item: "101", Kind: "movie"}, {Library: "2", Item: "202", Kind: "episode", Removed: true}}
	if err != nil || !reflect.DeepEqual(changes, want) {
		t.Fatal(changes, err)
	}
	if changes, err := s.LiveLibraryChanges([]byte(`{"NotificationContainer":{"type":"playing"}}`)); err != nil || changes != nil {
		t.Fatal("playback read as library changes", changes, err)
	}
	if _, err := s.LiveLibraryChanges([]byte(`{"NotificationContainer":null}`)); err == nil {
		t.Fatal("malformed notification accepted")
	}
}

// An episode's show, a season's show and a track's album are looked up; an
// item without one is refused.
func TestCatalogueParent(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Plex-Token") != "private-token" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		body := map[string]string{
			"/library/metadata/10": `<MediaContainer size="1"><Video ratingKey="10" type="episode" grandparentRatingKey="7" parentRatingKey="8"/></MediaContainer>`,
			"/library/metadata/8":  `<MediaContainer size="1"><Directory ratingKey="8" type="season" parentRatingKey="7"/></MediaContainer>`,
			"/library/metadata/30": `<MediaContainer size="1"><Track ratingKey="30" type="track" parentRatingKey="31" grandparentRatingKey="32"/></MediaContainer>`,
			"/library/metadata/40": `<MediaContainer size="1"><Video ratingKey="40" type="movie"/></MediaContainer>`,
		}[r.URL.Path]
		if body == "" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/xml")
		_, _ = w.Write([]byte(body))
	}))
	defer server.Close()
	s := New(provider.Config{URL: server.URL, APIKey: "private-token", Transport: provider.Transport{Client: server.Client()}})
	for item, want := range map[string]string{"10": "7", "8": "7", "30": "31"} {
		if got, err := s.CatalogueParent(t.Context(), item); err != nil || got != want {
			t.Fatal(item, got, err)
		}
	}
	for _, item := range []string{"40", "99", "x"} {
		if _, err := s.CatalogueParent(t.Context(), item); err == nil {
			t.Fatal("no parent accepted for", item)
		}
	}
}
