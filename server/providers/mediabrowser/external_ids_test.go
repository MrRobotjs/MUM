package mediabrowser

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"app/server/providers/provider"
)

// Library items ask for and keep each title's TMDB, TVDB and IMDb IDs.
func TestCatalogueItemsReadProviderIDs(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/Items" || !strings.Contains(r.URL.Query().Get("Fields"), "ProviderIds") {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		_, _ = w.Write([]byte(`{"TotalRecordCount":2,"Items":[
			{"Id":"aa11","Name":"Film","Type":"Movie","ProviderIds":{"Tmdb":"603","Imdb":"tt0133093","Tvdb":"bad"}},
			{"Id":"bb22","Name":"Show","Type":"Series","ProviderIds":{"Tvdb":"81189","Tmdb":"1396"}}]}`))
	}))
	t.Cleanup(server.Close)
	s := New(provider.Config{URL: server.URL, APIKey: "key", Transport: provider.Transport{Client: server.Client()}}, false)
	items, err := s.CatalogueItems(context.Background(), "lib1", "movies", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 2 || items[0].IDs != (provider.ExternalIDs{TMDB: 603, IMDb: "tt0133093"}) || items[1].IDs != (provider.ExternalIDs{TMDB: 1396, TVDB: 81189}) {
		t.Fatalf("%+v", items)
	}
}
