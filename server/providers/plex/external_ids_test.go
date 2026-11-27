package plex

import (
	"testing"

	"app/server/providers/provider"
)

func TestCatalogueEntryReadsExternalIDs(t *testing.T) {
	page, err := DecodeCataloguePage([]byte(`<MediaContainer size="2" totalSize="2" offset="0">` +
		`<Video ratingKey="1" type="movie" title="Film" guid="plex://movie/5d776825880197001ec967c9"><Guid id="imdb://tt0133093"/><Guid id="tmdb://603"/><Guid id="tvdb://169"/></Video>` +
		`<Video ratingKey="2" type="movie" title="Home video"/>` +
		`</MediaContainer>`))
	if err != nil {
		t.Fatal(err)
	}
	if ids := page.Items[0].externalIDs(); ids != (provider.ExternalIDs{TMDB: 603, TVDB: 169, IMDb: "tt0133093"}) {
		t.Fatalf("%+v", ids)
	}
	if ids := page.Items[1].externalIDs(); ids != (provider.ExternalIDs{}) {
		t.Fatalf("%+v", ids)
	}
}
